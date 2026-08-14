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

import { createTranscriptPersistence, type TranscriptPersistenceDeps } from "../src/session/transcript-persistence.js";

function fakeEventLog(over: any = {}) {
  const appended: Array<{ id: string; entry: any }> = [];
  const base: any[] = [];
  return {
    appended,
    baseSnapshots: base,
    append: (id: string, entry: any) => appended.push({ id, entry }),
    readBase: over.readBase ?? (() => []),
    appendBaseSnapshot: over.appendBaseSnapshot ?? ((_id: string, b: any) => base.push(b)),
    readInlineImages: over.readInlineImages ?? (() => []),
    appendInlineImage: () => {},
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

test("conversationMessages delegates to eventLog.deriveHistory", () => {
  const { tp } = harness({ eventLog: { deriveHistory: (_id: string, msgs: any) => [...msgs, { role: "assistant", content: "derived" }] } });
  const out = tp.conversationMessages(sess([{ role: "user", content: "hi" }]));
  assert.equal(out.length, 2);
  assert.equal((out[1] as any).content, "derived");
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
