// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Characterization tests for the transcript/event-log persistence glue extracted
// from server.ts. The event→entry mapping and the intermediate-coalescing state
// machine (the skip-when-unchanged guard that bounds append-only log growth) had
// no direct coverage while inline. createTranscriptPersistence's injected EventLog
// lets us drive them with a fake and assert exactly what gets appended.
import { strict as assert } from "node:assert";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createTranscriptPersistence, type TranscriptPersistenceDeps } from "../src/session/transcript-persistence.js";

function fakeEventLog(over: any = {}) {
  const appended: Array<{ id: string; entry: any }> = [];
  const inlineImages: any[] = [];
  const base: any[] = [];
  return {
    appended,
    baseSnapshots: base,
    append: (id: string, entry: any) => appended.push({ id, entry }),
    readBase: over.readBase ?? (() => []),
    appendBaseSnapshot: over.appendBaseSnapshot ?? ((_id: string, b: any) => base.push(b)),
    readInlineImages: over.readInlineImages ?? (() => []),
    inlineImages,
    appendInlineImage: (id: string, entry: any) => inlineImages.push({ id, ...entry }),
    flush: () => {},
    deriveHistory: over.deriveHistory ?? ((_id: string, msgs: any) => msgs),
    readAttachments: () => [],
  };
}

function harness(over: any = {}) {
  const eventLog = fakeEventLog(over.eventLog);
  const broadcasts: any[] = [];
  const deps: TranscriptPersistenceDeps = {
    eventLog: eventLog as any,
    attachmentStore: { put: () => ({ hash: "h", name: "n", mimeType: "image/png", kind: "image" }) } as any,
    broadcast: (p) => broadcasts.push(p),
    stampSessionEvent: (e) => e,
    getOpenSession: over.getOpenSession ?? (() => undefined),
    bivySessionEnvelope: () => ({ env: true }),
    sessionState: () => ({ displayStatus: "idle" }),
    runtimeDisplayName: () => "Claude Code",
    sequencerHead: () => 5,
    sequencerReplay: over.sequencerReplay ?? (() => ({ mode: "replay" as const, head: 9, events: [{ e: 1 }] })),
    streamEpoch: "epoch-1",
  };
  return { deps, eventLog, broadcasts, tp: createTranscriptPersistence(deps) };
}

const sess = (msgs: any[] = []) => ({ id: "s1", session: { getMessages: () => msgs } });

test("tool_call maps to a tool_use entry; tool_result to a tool_result entry; other events ignored", () => {
  const { tp, eventLog } = harness();
  tp.persistToolActivityFromEvent(sess(), { type: "tool_call", toolName: "Read", input: { path: "/x" }, id: "call-1" } as any);
  tp.persistToolActivityFromEvent(sess(), { type: "tool_result", id: "call-1", output: "ok" } as any);
  tp.persistToolActivityFromEvent(sess(), { type: "message_update" } as any);
  assert.equal(eventLog.appended.length, 2, "only the two tool events append");
  assert.equal(eventLog.appended[0].entry.id, "bivy-tool-call-call-1");
  assert.equal(eventLog.appended[0].entry.content[0].type, "tool_use");
  assert.equal(eventLog.appended[1].entry.id, "bivy-tool-result-call-1");
  assert.equal(eventLog.appended[1].entry.content[0].type, "tool_result");
});

test("a structured-pipe tool_result (id nested under result.toolCallId) pairs with its call", () => {
  const { tp, eventLog } = harness();
  // The shared TurnAccumulator (Grok/Goose/Gemini/…) emits a tool_result whose
  // only id is `result.toolCallId`, with a generic `toolName` and no input. A
  // prior version keyed this `"tool:"` — orphaning the output from its call.
  tp.persistToolActivityFromEvent(sess(), { type: "tool_call", toolName: "run_terminal_command", input: { command: "ls" }, toolCallId: "call-abc-0" } as any);
  tp.persistToolActivityFromEvent(sess(), { type: "tool_result", toolName: "tool", result: { toolCallId: "call-abc-0", content: "a\nb\n" } } as any);
  assert.equal(eventLog.appended[0].entry.id, "bivy-tool-call-call-abc-0");
  assert.equal(eventLog.appended[1].entry.id, "bivy-tool-result-call-abc-0", "result overlay pairs with the call id, not 'tool:'");
  assert.equal(eventLog.appended[1].entry.content[0].toolUseId, "call-abc-0");
});

test("a sub-agent tool_call persists its parentToolUseId onto the tool_use block so a reload still nests it", () => {
  const { tp, eventLog } = harness();
  // The delegation (Claude's Agent/Task tool) records first, then the sub-agent's
  // own call arrives carrying parentToolUseId = the delegation's id. The live
  // stream nests it; the persisted overlay must too, or reopening flattens it.
  tp.persistToolActivityFromEvent(sess(), { type: "tool_call", toolName: "Agent", input: { description: "count files" }, id: "parent-1" } as any);
  tp.persistToolActivityFromEvent(sess(), { type: "tool_call", toolName: "Bash", input: { command: "ls" }, id: "child-1", parentToolUseId: "parent-1" } as any);
  assert.equal(eventLog.appended.length, 2);
  assert.equal(eventLog.appended[0].entry.content[0].parentToolUseId, undefined, "a top-level call carries no parent");
  assert.equal(eventLog.appended[1].entry.content[0].parentToolUseId, "parent-1", "the sub-agent call nests under its delegation on reload");
  // Pi names the parent of a nested call (codemode, ctx.executeTool) parentToolCallId.
  tp.persistToolActivityFromEvent(sess(), { type: "tool_execution_start", toolName: "read", args: { path: "a" }, toolCallId: "child-2", parentToolCallId: "parent-1" } as any);
  assert.equal(eventLog.appended[2].entry.content[0].parentToolUseId, "parent-1", "a Pi nested call nests too");
});

test("a progress-only tool_execution_update (elapsedSeconds, no detail) does not overwrite the tool-call overlay", () => {
  const { tp, eventLog } = harness();
  // The initiating call records the real input + classification.
  tp.persistToolActivityFromEvent(sess(), { type: "tool_call", toolName: "Read", input: { path: "/x" }, id: "call-1", detail: { kind: "read", path: "/x" } } as any);
  // A keep-alive ping shares the `bivy-tool-call-call-1` key; persisting it
  // would clobber the real overlay, so it must be dropped from the log.
  tp.persistToolActivityFromEvent(sess(), { type: "tool_execution_update", toolName: "Read", id: "call-1", input: { elapsedSeconds: 3 } } as any);
  assert.equal(eventLog.appended.length, 1, "only the real tool_call overlay is persisted");
  assert.equal(eventLog.appended[0].entry.content[0].input.path, "/x");
  assert.ok(eventLog.appended[0].entry.content[0].detail, "classification survives");
});

test("an enriching tool_execution_update (with detail or real input) is still persisted", () => {
  const { tp, eventLog } = harness();
  tp.persistToolActivityFromEvent(sess(), { type: "tool_execution_update", toolName: "bash", id: "call-9", input: { command: "npm test" } } as any);
  assert.equal(eventLog.appended.length, 1, "an update that carries real tool input still records");
  assert.equal(eventLog.appended[0].entry.content[0].input.command, "npm test");
});

test("a streaming update without detail keeps the call's classification and parent (Pi's bash output)", () => {
  const { tp, eventLog } = harness();
  tp.persistToolActivityFromEvent(sess(), { type: "tool_execution_start", toolName: "bash", args: { command: "npm test" }, toolCallId: "call-7", parentToolCallId: "parent-1", detail: { kind: "shell", command: "npm test" } } as any);
  tp.persistToolActivityFromEvent(sess(), { type: "tool_execution_update", toolName: "bash", args: { command: "npm test" }, toolCallId: "call-7", partialResult: { content: [{ type: "text", text: "ok" }] } } as any);
  const latest = eventLog.appended[eventLog.appended.length - 1].entry.content[0];
  assert.equal(latest.detail?.kind, "shell");
  assert.equal(latest.parentToolUseId, "parent-1");
});

test("a turn failure reported on the tool channel (no tool, no call id) is not persisted as a tool card", () => {
  const { tp, eventLog } = harness();
  tp.persistToolActivityFromEvent(sess(), { type: "tool_result", error: "error_during_execution", message: "" } as any);
  assert.equal(eventLog.appended.length, 0);
});

test("intermediate coalescing: skips an unchanged non-final append, always writes final, re-opens after clear", () => {
  const { tp, eventLog } = harness();
  const ev = { assistantMessageEvent: { type: "thinking_end", content: "hello" } };
  tp.persistIntermediateFromEvent(sess(), ev, false);
  assert.equal(eventLog.appended.length, 1, "first reasoning append");
  tp.persistIntermediateFromEvent(sess(), ev, false);
  assert.equal(eventLog.appended.length, 1, "identical non-final is skipped — the log-growth bound");
  tp.persistIntermediateFromEvent(sess(), ev, true);
  assert.equal(eventLog.appended.length, 2, "final always writes the finished reasoning");
  // final cleared the live state, so a subsequent event starts a fresh entry.
  tp.persistIntermediateFromEvent(sess(), ev, false);
  assert.equal(eventLog.appended.length, 3, "state was cleared on final → re-opens");
});

test("empty thinking text never appends", () => {
  const { tp, eventLog } = harness();
  tp.persistIntermediateFromEvent(sess(), { assistantMessageEvent: { type: "thinking_end", content: "   " } }, false);
  assert.equal(eventLog.appended.length, 0);
});

test("clearLiveIntermediate drops the coalescing state", () => {
  const { tp, eventLog } = harness();
  const ev = { assistantMessageEvent: { type: "thinking_end", content: "hi" } };
  tp.persistIntermediateFromEvent(sess(), ev, false);
  tp.clearLiveIntermediate("s1");
  tp.persistIntermediateFromEvent(sess(), ev, false); // no live entry → fresh append, not a skip
  assert.equal(eventLog.appended.length, 2);
});

test("persistTranscriptSnapshot skips empty and rebases onto logged base", () => {
  const empty = harness();
  empty.tp.persistTranscriptSnapshot(sess([]));
  assert.equal(empty.eventLog.baseSnapshots.length, 0, "nothing to snapshot");

  const withBase = harness({ eventLog: { readBase: () => [{ role: "user", content: "old" }] } });
  withBase.tp.persistTranscriptSnapshot(sess([{ role: "user", content: "old" }, { role: "assistant", content: "new" }]));
  assert.equal(withBase.eventLog.baseSnapshots.length, 1, "a non-empty transcript is snapshotted (rebased onto logged history)");
});

test("buildHistoryEvent merges live-record fields over the metadata fallbacks", () => {
  const { tp } = harness({
    getOpenSession: () => ({ sessionFile: "/s.json", worktree: { branch: "bivy/x" }, warning: "w", prUrl: "u", prs: [], session: { getName: () => "Live Name" } }),
  });
  const ev = tp.buildHistoryEvent({ sessionId: "s1", workspace: "/ws", runtimeId: "claude-code-sdk", isStreaming: false, messages: [], name: "fallback", branch: "fallback-branch" });
  assert.equal(ev.name, "Live Name", "live record name wins over fallback");
  assert.equal(ev.branch, "bivy/x", "live worktree branch wins");
  assert.equal(ev.agentName, "Claude Code");
  assert.equal(ev.streamEpoch, "epoch-1");
  assert.equal(ev.headSeq, 5);
});

test("buildReplayEvent returns events on replay and empty on reset", () => {
  const replay = harness();
  const r = replay.tp.buildReplayEvent("s1", 3);
  assert.equal(r.mode, "replay");
  assert.deepEqual(r.events, [{ e: 1 }]);

  const reset = harness({ sequencerReplay: () => ({ mode: "reset" as const, head: 20 }) });
  const x = reset.tp.buildReplayEvent("s1", 3);
  assert.equal(x.mode, "reset");
  assert.deepEqual(x.events, [], "reset carries no events");
});

// ---------------------------------------------------------------- workspace images
// `![alt](out/chart.png)` — an agent illustrating a reply with a file it just
// produced, with no tool call. planAttachment's confinement (including the
// symlink-escape case) is covered at its own level in attach-to-chat.test.ts;
// what has no coverage otherwise is this wiring: that the resolver reaches the
// disk through it, captures the bytes into the transcript at emit time, and
// records them under the reference exactly as the markdown wrote it.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 7)]);

function workspace(files: Record<string, Buffer | string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-wsimg-"));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  return dir;
}

test("resolveWorkspaceImages stores a workspace image and records it under the path as written", () => {
  const dir = workspace({ "out/chart.png": PNG });
  const stored: Buffer[] = [];
  const h = harness();
  (h.deps.attachmentStore as any).put = (bytes: Buffer, meta: any) => {
    stored.push(bytes);
    return { hash: "h1", name: meta.name, mimeType: meta.mimeType, size: bytes.length, kind: meta.kind };
  };
  h.tp.resolveWorkspaceImages(sess([{ role: "assistant", content: "Here it is:\n\n![A chart](./out/chart.png)" }]), dir);

  assert.equal(stored.length, 1, "the bytes are captured at emit time, not left in the workspace");
  assert.ok(stored[0].equals(PNG));
  assert.equal((h.eventLog as any).inlineImages.length, 1);
  assert.equal((h.eventLog as any).inlineImages[0].url, "./out/chart.png", "keyed by the reference the markdown wrote");
  assert.equal((h.eventLog as any).inlineImages[0].ref.mimeType, "image/png", "classified from the bytes, not the extension");
  assert.equal(h.broadcasts.length, 1, "clients are told live, not only on reload");
  assert.equal((h.broadcasts[0] as any).event.type, "inlineImage");
});

test("resolveWorkspaceImages refuses a file that is not an image", () => {
  const dir = workspace({ "notes.md": "# not an image" });
  const h = harness();
  h.tp.resolveWorkspaceImages(sess([{ role: "assistant", content: "![notes](notes.md)" }]), dir);
  assert.equal((h.eventLog as any).inlineImages.length, 0, "a mistyped link must not become an unopenable chip");
  assert.equal(h.broadcasts.length, 0);
});

test("resolveWorkspaceImages skips a reference the log already resolved", () => {
  const dir = workspace({ "out/chart.png": PNG });
  const h = harness({ eventLog: { readInlineImages: () => [["out/chart.png", { hash: "old" }]] } });
  h.tp.resolveWorkspaceImages(sess([{ role: "assistant", content: "![c](out/chart.png)" }]), dir);
  assert.equal((h.eventLog as any).inlineImages.length, 0, "re-rendering history must not re-read the disk");
});

test("resolveWorkspaceImages ignores a message with no workspace reference", () => {
  const dir = workspace({ "out/chart.png": PNG });
  const h = harness();
  // A remote URL is the other resolver's job, and an absolute path is refused by
  // the grammar before anything touches the filesystem.
  h.tp.resolveWorkspaceImages(sess([{ role: "assistant", content: "![a](https://x.test/a.png) ![b](/etc/passwd)" }]), dir);
  assert.equal((h.eventLog as any).inlineImages.length, 0);
});
