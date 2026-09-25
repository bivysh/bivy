// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { strict as assert } from "node:assert";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventLog, foldIntermediate, foldTool, replayExtras, baseReplay, mergeBases, parseLog, type EventLogEntry, type LogRecord, replayAttachments } from "../src/session/event-log.js";
import { mergeTranscript, normalizedIntermediateText, thinkingTextFromContent, type SidecarMessage } from "../src/session/transcript-merge.js";
import type { AttachmentRef } from "../src/session/attachment-store.js";

// --- Faithful re-implementation of the LEGACY two-sidecar fold ------------------
// Copied from server.ts (upsertIntermediateMessage / upsertToolActivityMessage) so
// the equivalence tests below prove the append-only replay reproduces exactly what
// the whole-file JSON stores held — the property the shadow-write rollout relies on.
function legacyIntermediate(events: readonly EventLogEntry[]): EventLogEntry[] {
  const messages: EventLogEntry[] = [];
  for (const entry of events) {
    const entryText = normalizedIntermediateText(thinkingTextFromContent(entry.content));
    const duplicateIndex = entryText
      ? messages.findIndex((m) => m.id !== entry.id && m.afterMessageCount === entry.afterMessageCount && normalizedIntermediateText(thinkingTextFromContent(m.content)) === entryText)
      : -1;
    const index = messages.findIndex((m) => m.id === entry.id);
    if (index >= 0) messages[index] = entry;
    else if (duplicateIndex >= 0) messages[duplicateIndex] = { ...messages[duplicateIndex], ...entry, id: messages[duplicateIndex]!.id, createdAt: Math.min(messages[duplicateIndex]!.createdAt, entry.createdAt) };
    else messages.push(entry);
    messages.sort((a, b) => a.afterMessageCount - b.afterMessageCount || a.createdAt - b.createdAt);
  }
  return messages;
}

function legacyTool(events: readonly EventLogEntry[]): EventLogEntry[] {
  let messages: EventLogEntry[] = [];
  for (const entry of events) {
    const index = messages.findIndex((m) => m.id === entry.id);
    if (index >= 0) messages[index] = { ...messages[index], ...entry };
    else messages.push(entry);
    messages.sort((a, b) => a.afterMessageCount - b.afterMessageCount || a.createdAt - b.createdAt);
    messages = messages.slice(-500);
  }
  return messages;
}

/** The legacy `mergeConversation` extras: intermediate sidecar then tool sidecar. */
function legacyExtras(events: readonly EventLogEntry[]): SidecarMessage[] {
  const intermediate = events.filter((e) => e.bivyKind === "intermediate");
  const tool = events.filter((e) => e.bivyKind === "tool");
  return [...legacyIntermediate(intermediate), ...legacyTool(tool)];
}

// --- Fixtures -------------------------------------------------------------------
const baseMsg = (role: string, text: string, timestamp: number) => ({ role, content: [{ type: "text", text }], timestamp });
const think = (id: string, text: string, afterMessageCount: number, createdAt: number): EventLogEntry => ({
  role: "assistant",
  bivyKind: "intermediate",
  afterMessageCount,
  createdAt,
  id,
  content: [{ type: "thinking", thinking: text }],
});
const toolCall = (callId: string, name: string, afterMessageCount: number, createdAt: number): EventLogEntry => ({
  role: "assistant",
  bivyKind: "tool",
  afterMessageCount,
  createdAt,
  id: `bivy-tool-call-${callId}`,
  content: [{ type: "tool_use", id: callId, name, input: { path: "x" } }],
});
const toolResult = (callId: string, afterMessageCount: number, createdAt: number): EventLogEntry => ({
  role: "assistant",
  bivyKind: "tool",
  afterMessageCount,
  createdAt,
  id: `bivy-tool-result-${callId}`,
  content: [{ type: "tool_result", toolUseId: callId, tool_use_id: callId, content: "ok", isError: false }],
});

// Representative event streams: each mirrors a real recording shape.
const STREAMS: Record<string, EventLogEntry[]> = {
  "streaming reasoning (same id refined per delta)": [
    think("i1", "Let me", 1, 100),
    think("i1", "Let me think", 1, 100),
    think("i1", "Let me think about it", 1, 100),
    toolCall("c1", "Read", 1, 150),
    toolResult("c1", 1, 160),
  ],
  "duplicate reasoning text under different ids (deduped onto the first)": [
    think("i1", "same thought", 2, 200),
    think("i2", "same thought", 2, 250), // same text + anchor, different id → merges onto i1
  ],
  "tool call then result, interleaved with a later turn": [
    toolCall("c1", "Bash", 1, 150),
    think("i1", "planning", 1, 155),
    toolResult("c1", 1, 180),
    toolCall("c2", "Edit", 3, 350),
    toolResult("c2", 3, 360),
  ],
  "compaction-style overflow (afterMessageCount past the end)": [
    toolCall("early", "Read", 900, 150),
    toolCall("mid", "Grep", 937, 350),
  ],
  "tool update refines the same call id": [
    toolCall("c1", "Bash", 1, 150),
    { ...toolCall("c1", "Bash", 1, 150), createdAt: 151 }, // a refining update to the same id
  ],
};

const BASE = [baseMsg("user", "q1", 100), baseMsg("assistant", "a1", 200), baseMsg("user", "q2", 300), baseMsg("assistant", "final", 400)];

test("mergeBases replaces an in-place streaming revision instead of duplicating it", () => {
  const partial = baseMsg("assistant", "Both counts", 200);
  const final = baseMsg("assistant", "Both counts agreed: 2.", 200);
  assert.deepEqual(mergeBases([baseMsg("user", "count", 100), partial], [baseMsg("user", "count", 100), final]), [baseMsg("user", "count", 100), final]);
});

test("mergeBases repairs streaming revisions already duplicated in the log", () => {
  const partial = baseMsg("assistant", "Both counts", 200);
  const final = baseMsg("assistant", "Both counts agreed: 2.", 200);
  assert.deepEqual(mergeBases([baseMsg("user", "count", 100), partial, final], [final]), [baseMsg("user", "count", 100), final]);
});

test("mergeBases still appends a disjoint resumed turn", () => {
  const logged = [baseMsg("user", "old", 100), baseMsg("assistant", "answer", 200)];
  const resumed = [baseMsg("user", "new", 300), baseMsg("assistant", "reply", 400)];
  assert.deepEqual(mergeBases(logged, resumed), [...logged, ...resumed]);
});

test("mergeBases folds a native-store reopen: the same turns re-serialized with fresh timestamps never double-appear", () => {
  // The reopen bug: a native-store agent (Claude/Codex/Pi/OpenCode) reloads its
  // FULL transcript with the agent's OWN timestamps (not the Date.now() Bivy
  // stamped when it streamed the event-log base) and a possibly different block
  // shape. Same conversation, different serialization — the id/timestamp fold
  // can't match it, so before this every turn duplicated on reopen.
  const toolUse = (id: string, name: string, ts: number) => ({ role: "assistant", content: [{ type: "tool_use", id, name, input: {} }], timestamp: ts });
  const toolResult = (id: string, ts: number) => ({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }], timestamp: ts });
  const streamed = [baseMsg("user", "run echo", 1000), toolUse("toolu_1", "Bash", 1001), toolResult("toolu_1", 1002), baseMsg("assistant", "done", 1003)];
  // Native reload: identical content, DIFFERENT timestamps (and the CLI omits the
  // tool `input`/`name` echo — shape differs, tool id is the stable anchor).
  const reloaded = [baseMsg("user", "run echo", 5000), { role: "assistant", content: [{ type: "tool_use", id: "toolu_1" }], timestamp: 5001 }, toolResult("toolu_1", 5002), baseMsg("assistant", "done", 5003)];
  const merged = mergeBases(streamed, reloaded);
  assert.equal(merged.length, 4, "reopen keeps a single copy of the four turns");
  assert.deepEqual(merged.map((m) => (m as any).role), ["user", "assistant", "user", "assistant"]);
});

test("mergeBases folds a reopen even when the native reload re-chunks the turn differently (OpenCode shape)", () => {
  // OpenCode's ACP reload restates the whole turn as just [user, final text] — the
  // tool blocks live only in Bivy's overlays, and the final text that the streamed
  // base bundled INTO a tool+text message arrives standalone. Atom coverage (tool
  // ids + text fragments) still recognizes it as the same conversation.
  const streamed = [
    baseMsg("user", "create oc-test.txt", 1000),
    { role: "assistant", content: [{ type: "tool_use", id: "call_edit", name: "edit", input: {} }], timestamp: 1001 },
    { role: "assistant", content: [{ type: "tool_use", id: "call_read", name: "read", input: {} }, { type: "text", text: "Contents: opencode ok" }], timestamp: 1002 },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call_edit", content: "" }, { type: "tool_result", tool_use_id: "call_read", content: "opencode ok" }], timestamp: 1003 },
  ];
  const reloaded = [baseMsg("user", "create oc-test.txt", 9000), baseMsg("assistant", "Contents: opencode ok", 9001)];
  const merged = mergeBases(streamed as any, reloaded);
  assert.equal(merged.length, streamed.length, "the minimal native reload adds no duplicate turn");
});

test("mergeBases folds a reloaded thinking-only message instead of appending it after the final answer", () => {
  // Claude persists each thinking block as its own assistant message. On reopen
  // the native reload restamps it; with no tool id or text it used to count as
  // opaque and land at the very end of the transcript.
  const thinking = (text: string, ts: number) => ({ role: "assistant", content: [{ type: "thinking", thinking: text, signature: "sig" }], timestamp: ts });
  const streamed = [baseMsg("user", "go", 1000), thinking("plan the work", 1001), baseMsg("assistant", "done", 1002)];
  const reloaded = [baseMsg("user", "go", 5000), thinking("plan the work", 5001), baseMsg("assistant", "done", 5002)];
  assert.deepEqual(mergeBases(streamed, reloaded), streamed);
});

test("mergeBases keeps a genuinely repeated message (positional, not set-based, dedup)", () => {
  // A user who sends "run tests" twice must keep BOTH turns — the content fold is
  // positional (aligns two serializations of ONE conversation), never a flat set
  // that would collapse legitimate repeats.
  const logged = [baseMsg("user", "run tests", 100), baseMsg("assistant", "passed", 200), baseMsg("user", "run tests", 300), baseMsg("assistant", "passed", 400)];
  assert.deepEqual(mergeBases(logged, []), logged);
  assert.equal(mergeBases(logged, logged).length, 4, "a re-serialization of the same 4 turns stays 4, repeats intact");
});

test("replayExtras reproduces the legacy two-sidecar fold for every stream", () => {
  for (const [name, events] of Object.entries(STREAMS)) {
    const viaLog = mergeTranscript(BASE, replayExtras(events));
    const viaLegacy = mergeTranscript(BASE, legacyExtras(events));
    assert.deepEqual(viaLog, viaLegacy, `stream mismatch: ${name}`);
  }
});

test("foldIntermediate / foldTool match the legacy per-kind folds", () => {
  for (const events of Object.values(STREAMS)) {
    const intermediate = events.filter((e) => e.bivyKind === "intermediate");
    const tool = events.filter((e) => e.bivyKind === "tool");
    assert.deepEqual(foldIntermediate(intermediate), legacyIntermediate(intermediate));
    assert.deepEqual(foldTool(tool), legacyTool(tool));
  }
});

test("tool fold keeps only the most recent 500 entries, like the legacy cap", () => {
  const many: EventLogEntry[] = Array.from({ length: 600 }, (_, i) => toolCall(`c${i}`, "Read", i, 1000 + i));
  const folded = foldTool(many);
  assert.equal(folded.length, 500);
  assert.deepEqual(folded, legacyTool(many));
});

test("EventLog round-trips through disk: append → flush → fresh read replays identically", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-eventlog-"));
  try {
    const pathFor = (id: string) => path.join(dir, `${encodeURIComponent(id)}.jsonl`);
    const events = STREAMS["tool call then result, interleaved with a later turn"]!;
    const log = new EventLog(dir, pathFor, (t) => t, 0); // throttle 0 → each append flushes immediately
    assert.equal(log.hasEntries("s1"), false);
    for (const e of events) log.append("s1", e);
    log.flush("s1");
    assert.equal(log.hasEntries("s1"), true);

    // A brand-new instance reads only what's on disk.
    const reopened = new EventLog(dir, pathFor);
    const merged = mergeTranscript(BASE, reopened.read("s1"));
    assert.deepEqual(merged, mergeTranscript(BASE, legacyExtras(events)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("coalescing collapses same-id updates within a flush window to one disk line", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-eventlog-"));
  try {
    const pathFor = (id: string) => path.join(dir, `${encodeURIComponent(id)}.jsonl`);
    const log = new EventLog(dir, pathFor, (t) => t, 10_000); // large throttle → one window
    // The first append always flushes immediately (like SidecarStore); prime it so
    // the subsequent same-id deltas land in one throttled window.
    log.append("s1", toolCall("c0", "Read", 0, 90));
    log.flush("s1");
    log.append("s1", think("i1", "a", 1, 100));
    log.append("s1", think("i1", "ab", 1, 100));
    log.append("s1", think("i1", "abc", 1, 100));
    log.flush("s1");
    const lines = fs.readFileSync(pathFor("s1"), "utf8").trim().split("\n").filter(Boolean);
    assert.equal(lines.length, 2, "the primer plus one coalesced line for the three same-id deltas");
    assert.equal(JSON.parse(lines[1]!).content[0].thinking, "abc");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("append snapshots the entry: later mutation of the live object does not change the log", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-eventlog-"));
  try {
    const pathFor = (id: string) => path.join(dir, `${encodeURIComponent(id)}.jsonl`);
    const log = new EventLog(dir, pathFor, (t) => t, 0);
    const live = think("i1", "first", 1, 100);
    log.append("s1", live);
    live.content = [{ type: "thinking", thinking: "MUTATED" }]; // server reuses the live object
    log.flush("s1");
    const stored = replayExtras(parseLog(fs.readFileSync(pathFor("s1"), "utf8")));
    assert.equal(thinkingTextFromContent(stored[0]!.content), "first");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("drop cancels the pending trailing flush so a late timer can't rewrite the file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-eventlog-"));
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  try {
    const pathFor = (id: string) => path.join(dir, `${encodeURIComponent(id)}.jsonl`);
    const log = new EventLog(dir, pathFor, (t) => t, 30);
    log.append("s1", toolCall("c1", "Read", 1, 100)); // immediate first flush → file has 1 line
    log.append("s1", toolResult("c1", 1, 110)); // within the window → schedules a trailing flush
    log.drop("s1"); // cancels that trailing flush and forgets the cache
    await sleep(60); // longer than the throttle: the cancelled timer must not fire
    const lines = fs.readFileSync(pathFor("s1"), "utf8").trim().split("\n").filter(Boolean);
    assert.equal(lines.length, 1, "the pending second write was cancelled by drop");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rewrite seeds the log from legacy overlays so replay reproduces the legacy fold (migration)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-eventlog-"));
  try {
    const pathFor = (id: string) => path.join(dir, `${encodeURIComponent(id)}.jsonl`);
    // The legacy sidecars as the migration reads them: the two stored (already
    // folded) arrays, concatenated — intermediate then tool.
    const legacy = [...foldIntermediate(STREAMS["duplicate reasoning text under different ids (deduped onto the first)"]!.filter((e) => e.bivyKind === "intermediate")), ...foldTool(STREAMS["tool call then result, interleaved with a later turn"]!.filter((e) => e.bivyKind === "tool"))];

    const log = new EventLog(dir, pathFor, (t) => t, 0);
    // Simulate a spanning session: a partial shadow log already exists...
    log.append("s1", legacy[legacy.length - 1]!);
    log.flush("s1");
    // ...then migration overwrites it with the complete legacy record.
    log.rewrite("s1", legacy);

    // A fresh instance reads only the migrated file: replay must equal the legacy fold.
    const reopened = new EventLog(dir, pathFor);
    assert.deepEqual(mergeTranscript(BASE, reopened.read("s1")), mergeTranscript(BASE, legacy));
    // No duplication from the pre-migration partial entry: the migrated log holds
    // exactly the legacy set.
    assert.equal(reopened.entries("s1").length, legacy.length);

    // Idempotent: migrating again yields the same result.
    log.rewrite("s1", legacy);
    assert.deepEqual(new EventLog(dir, pathFor).read("s1"), reopened.read("s1"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("parseLog skips blank and malformed lines", () => {
  const body = [
    JSON.stringify(toolCall("c1", "Read", 1, 100)),
    "",
    "{ not json",
    JSON.stringify({ role: "user", content: "no bivyKind" }), // invalid: not a log record
    JSON.stringify(toolResult("c1", 1, 110)),
  ].join("\n");
  const parsed = parseLog(body).filter((r): r is EventLogEntry => r.bivyKind !== "base");
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0]!.id, "bivy-tool-call-c1");
  assert.equal(parsed[1]!.id, "bivy-tool-result-c1");
});

// --- Base transcript fold ------------------------------------------------------
// The base is a full getMessages() snapshot overwritten each turn that SHRINKS on
// compaction. It's stored as bounded deltas (reset|extend); replay must reproduce
// the last snapshot exactly. `snapshots` is the sequence of snapshots the server
// would persist across turns; the invariant is readBase == the final snapshot.

const baseRecord = (reset: boolean, messages: unknown[], createdAt = 1): LogRecord =>
  ({ bivyKind: "base", reset, createdAt, messages } as unknown as LogRecord);

test("baseReplay folds resets and extends into the final snapshot", () => {
  const entries: LogRecord[] = [
    baseRecord(true, [baseMsg("user", "q1", 100)]),
    baseRecord(false, [baseMsg("assistant", "a1", 200)]),
    baseRecord(true, [baseMsg("user", "compacted", 300)]), // compaction shrinks + rewrites
    baseRecord(false, [baseMsg("assistant", "a2", 400)]),
  ];
  assert.deepEqual(baseReplay(entries), [baseMsg("user", "compacted", 300), baseMsg("assistant", "a2", 400)]);
  assert.deepEqual(baseReplay([]), []);
});

test("replayExtras and baseReplay ignore each other's records when interleaved", () => {
  const mixed: LogRecord[] = [
    baseRecord(true, [baseMsg("user", "q1", 100)]),
    toolCall("c1", "Read", 1, 150),
    baseRecord(false, [baseMsg("assistant", "a1", 200)]),
    think("i1", "planning", 1, 155),
  ];
  assert.deepEqual(baseReplay(mixed), [baseMsg("user", "q1", 100), baseMsg("assistant", "a1", 200)]);
  // Overlay fold sees only the overlay records — same as if the base records weren't there.
  assert.deepEqual(replayExtras(mixed), replayExtras(mixed.filter((r) => r.bivyKind !== "base")));
});

test("appendBaseSnapshot stores a prefix-extend as a tail-only delta", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-eventlog-"));
  try {
    const pathFor = (id: string) => path.join(dir, `${encodeURIComponent(id)}.jsonl`);
    const log = new EventLog(dir, pathFor, (t) => t, 0);
    const snap1 = [baseMsg("user", "q1", 100)];
    const snap2 = [baseMsg("user", "q1", 100), baseMsg("assistant", "a1", 200)];
    log.appendBaseSnapshot("s1", snap1);
    log.appendBaseSnapshot("s1", snap2);
    log.flush("s1");
    const records = parseLog(fs.readFileSync(pathFor("s1"), "utf8")).filter((r) => r.bivyKind === "base");
    assert.equal(records.length, 2);
    assert.equal((records[0] as { reset: boolean }).reset, true, "first snapshot seeds a full reset");
    assert.equal((records[1] as { reset: boolean }).reset, false, "the extension is a tail delta");
    assert.deepEqual((records[1] as { messages: unknown[] }).messages, [baseMsg("assistant", "a1", 200)], "tail only");
    assert.deepEqual(log.readBase("s1"), snap2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("appendBaseSnapshot: an identical snapshot appends nothing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-eventlog-"));
  try {
    const pathFor = (id: string) => path.join(dir, `${encodeURIComponent(id)}.jsonl`);
    const log = new EventLog(dir, pathFor, (t) => t, 0);
    const snap = [baseMsg("user", "q1", 100), baseMsg("assistant", "a1", 200)];
    log.appendBaseSnapshot("s1", snap);
    log.appendBaseSnapshot("s1", snap); // no change
    log.flush("s1");
    assert.equal(log.entries("s1").filter((r) => r.bivyKind === "base").length, 1);
    assert.deepEqual(log.readBase("s1"), snap);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("appendBaseSnapshot: compaction (shrink) and mid-prefix mutation force a full reset", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-eventlog-"));
  try {
    const pathFor = (id: string) => path.join(dir, `${encodeURIComponent(id)}.jsonl`);
    const log = new EventLog(dir, pathFor, (t) => t, 0);
    // A realistic turn-by-turn sequence: grow, grow, COMPACT (shrink), grow, then an
    // in-place rewrite of an existing message (prefix changed at equal-or-greater len).
    const snaps = [
      [baseMsg("user", "q1", 100)],
      [baseMsg("user", "q1", 100), baseMsg("assistant", "a1", 200)],
      [baseMsg("user", "summary", 250)], // compaction: shorter, different prefix
      [baseMsg("user", "summary", 250), baseMsg("assistant", "a2", 300)],
      [baseMsg("user", "summary-edited", 250), baseMsg("assistant", "a2", 300)], // msg[0] mutated
    ];
    for (const s of snaps) log.appendBaseSnapshot("s1", s);
    log.flush("s1");
    const resets = log.entries("s1").filter((r) => r.bivyKind === "base" && (r as { reset: boolean }).reset).length;
    assert.equal(resets, 3, "seed + compaction + mid-prefix mutation each reset");
    // The invariant that matters: replay reproduces the last snapshot exactly.
    assert.deepEqual(log.readBase("s1"), snaps[snaps.length - 1]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("appendBaseSnapshot deep-copies: mutating the runtime objects later can't change the log", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-eventlog-"));
  try {
    const pathFor = (id: string) => path.join(dir, `${encodeURIComponent(id)}.jsonl`);
    const log = new EventLog(dir, pathFor, (t) => t, 0);
    const live = [baseMsg("user", "q1", 100)];
    log.appendBaseSnapshot("s1", live);
    (live[0] as { content: unknown }).content = [{ type: "text", text: "MUTATED" }];
    log.flush("s1");
    const reopened = new EventLog(dir, pathFor);
    assert.deepEqual(reopened.readBase("s1"), [baseMsg("user", "q1", 100)]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("appendBaseSnapshot round-trips through disk and seeds prevKeys from disk after restart", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-eventlog-"));
  try {
    const pathFor = (id: string) => path.join(dir, `${encodeURIComponent(id)}.jsonl`);
    const snap1 = [baseMsg("user", "q1", 100), baseMsg("assistant", "a1", 200)];
    const log = new EventLog(dir, pathFor, (t) => t, 0);
    log.appendBaseSnapshot("s1", snap1);
    log.flush("s1");
    // A brand-new instance (fresh baseKeys) extends the on-disk base: it must diff
    // against what's on disk, appending only the new tail — not a redundant reset.
    const restarted = new EventLog(dir, pathFor, (t) => t, 0);
    const snap2 = [...snap1, baseMsg("user", "q2", 300)];
    restarted.appendBaseSnapshot("s1", snap2);
    restarted.flush("s1");
    const baseRecords = parseLog(fs.readFileSync(pathFor("s1"), "utf8")).filter((r) => r.bivyKind === "base");
    assert.equal(baseRecords.length, 2, "the restart appended one tail delta, not a full reset");
    assert.equal((baseRecords[1] as { reset: boolean }).reset, false);
    assert.deepEqual(new EventLog(dir, pathFor).readBase("s1"), snap2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("missing logs are empty, but malformed logs and append failures are reported", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-eventlog-"));
  try {
    const issues: Array<{ operation: string; message: string }> = [];
    const missing = new EventLog(dir, (id) => path.join(dir, `${id}.jsonl`), (t) => t, 0, (issue) => issues.push(issue));
    assert.deepEqual(missing.read("missing"), []);
    assert.equal(issues.length, 0, "ENOENT is the only normal empty-log state");

    fs.writeFileSync(path.join(dir, "corrupt.jsonl"), "{not-json}\n");
    assert.deepEqual(missing.diskUsage(), { files: 1, bytes: Buffer.byteLength("{not-json}\n") });
    assert.deepEqual(missing.read("corrupt"), []);
    assert.equal(issues.at(-1)?.operation, "parse");
    assert.equal(missing.health().ok, false);

    const appendIssues: Array<{ operation: string }> = [];
    const unwritable = new EventLog(dir, (id) => path.join(dir, "missing-parent", `${id}.jsonl`), (t) => t, 0, (issue) => appendIssues.push(issue));
    unwritable.append("s1", STREAMS["streaming reasoning (same id refined per delta)"]![0]!);
    assert.equal(appendIssues.at(-1)?.operation, "append");
    assert.equal(unwritable.health().pendingSessions, 1, "failed appends stay queued for retry");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("deriveHistory unions the runtime base with the log's base and never shrinks", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-eventlog-"));
  try {
    const pathFor = (id: string) => path.join(dir, `${encodeURIComponent(id)}.jsonl`);
    const log = new EventLog(dir, pathFor, (t) => t, 0);
    for (const e of STREAMS["tool call then result, interleaved with a later turn"]!) log.append("s1", e);
    log.appendBaseSnapshot("s1", BASE);
    log.flush("s1");
    // Runtime base present and matching → merged onto it (same as mergeConversation did live).
    assert.deepEqual(log.deriveHistory("s1", BASE), mergeTranscript(BASE, log.read("s1")));
    // Runtime base empty (reopened process-agent session) → replay the persisted base.
    assert.deepEqual(log.deriveHistory("s1", []), mergeTranscript(BASE, log.read("s1")));
    assert.deepEqual(log.deriveHistory("s1"), mergeTranscript(BASE, log.read("s1")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("deriveHistory: a resumed blank runtime reporting a strict prefix keeps the persisted base", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-eventlog-"));
  try {
    const pathFor = (id: string) => path.join(dir, `${encodeURIComponent(id)}.jsonl`);
    const log = new EventLog(dir, pathFor, (t) => t, 0);
    log.appendBaseSnapshot("s1", BASE);
    log.flush("s1");
    // opencode resume: session/load returns no history, so the runtime only ever
    // reports the post-resume tail. The union must keep the full persisted base.
    const tail = [baseMsg("assistant", "a1", 200)];
    assert.deepEqual(log.deriveHistory("s1", tail), mergeTranscript(BASE, log.read("s1")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("deriveHistory: a resumed blank runtime's disjoint new turns concatenate after the persisted base", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-eventlog-"));
  try {
    const pathFor = (id: string) => path.join(dir, `${encodeURIComponent(id)}.jsonl`);
    const log = new EventLog(dir, pathFor, (t) => t, 0);
    log.appendBaseSnapshot("s1", BASE);
    log.flush("s1");
    // The runtime has no history of q1/final, only the brand-new turn 2, so its
    // base is disjoint from (and shorter than) the log's. Both must survive, in
    // log-then-runtime order.
    const newTurn = [baseMsg("user", "q2b", 500), baseMsg("assistant", "a2b", 600)];
    const derived = log.deriveHistory("s1", newTurn);
    assert.deepEqual(derived, mergeTranscript([...BASE, ...newTurn], log.read("s1")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- merged from event-log-attachments.test.ts ---
{
  function ref(hash: string, kind: "image" | "file" = "image"): AttachmentRef {
    return { hash, name: `${hash}.png`, mimeType: "image/png", size: 10, kind };
  }

  function tmpLog(): { log: EventLog; dir: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-elog-"));
    return { log: new EventLog(dir, (id) => path.join(dir, `${encodeURIComponent(id)}.jsonl`)), dir };
  }

  test("appendAttachments persists refs keyed by text and survives a flush + reload", () => {
    const { log, dir } = tmpLog();
    log.appendAttachments("s1", "look at this [Image attachment: a.png]", [ref("a".repeat(64))]);
    log.flush("s1");
    // A fresh EventLog over the same dir reads the persisted record back.
    const reopened = new EventLog(dir, (id) => path.join(dir, `${encodeURIComponent(id)}.jsonl`));
    const got = reopened.readAttachments("s1");
    assert.equal(got.length, 1);
    assert.equal(got[0]![0], "look at this [Image attachment: a.png]");
    assert.equal(got[0]![1][0]!.hash, "a".repeat(64));
  });

  test("appendAttachments is a no-op without text or refs", () => {
    const { log } = tmpLog();
    log.appendAttachments("s1", "", [ref("a".repeat(64))]);
    log.appendAttachments("s1", "some text", []);
    assert.deepEqual(log.readAttachments("s1"), []);
  });

  test("replayAttachments is last-write-wins per text, preserving first-seen order", () => {
    const records: LogRecord[] = [
      { bivyKind: "attachment", createdAt: 1, text: "one", refs: [ref("1".repeat(64))] },
      { bivyKind: "attachment", createdAt: 2, text: "two", refs: [ref("2".repeat(64))] },
      { bivyKind: "attachment", createdAt: 3, text: "one", refs: [ref("3".repeat(64))] }, // re-keys "one"
    ];
    const folded = replayAttachments(records);
    // "one" moved to the end (newest) with its updated ref; "two" retained.
    assert.deepEqual(folded.map(([t]) => t), ["two", "one"]);
    assert.equal(folded.find(([t]) => t === "one")![1][0]!.hash, "3".repeat(64));
  });
}
