// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { strict as assert } from "node:assert";
import test from "node:test";

import {
  applyReplFrame,
  buildReplFrame,
  cursorOf,
  initialReplState,
  type ApplyDeps,
  type ReplState,
} from "../src/session/replication.js";
import type { LogRecord } from "../src/session/event-log.js";

// A base-transcript record (a turn's snapshot delta) and an overlay tool record —
// the two shapes the event log actually holds.
const base = (n: number, createdAt: number): LogRecord => ({
  bivyKind: "base",
  reset: false,
  createdAt,
  messages: [{ role: "assistant", content: [{ type: "text", text: `turn ${n}` }], timestamp: createdAt }],
});
const tool = (id: string, afterMessageCount: number, createdAt: number): LogRecord => ({
  bivyKind: "tool",
  afterMessageCount,
  createdAt,
  id,
  content: [{ type: "tool_use", id, name: "bash", input: { command: "ls" } }],
});

/** A recording ApplyDeps that captures the last persisted list + checkpoint calls. */
function recorder(opts: { failCheckpoint?: boolean } = {}) {
  const persisted: LogRecord[][] = [];
  const fetched: string[] = [];
  const deps: ApplyDeps = {
    persist: (_id, records) => void persisted.push(records),
    fetchCheckpoint: async (_id, commit) => {
      if (opts.failCheckpoint) throw new Error("git fetch failed");
      fetched.push(commit);
    },
  };
  return { deps, persisted, fetched };
}

test("buildReplFrame returns null when the standby is already up to date", () => {
  const records = [base(1, 100)];
  const frame = buildReplFrame({ sessionId: "s", epoch: 1, records });
  assert.ok(frame, "first send is a full frame");
  const upToDate = buildReplFrame({
    sessionId: "s",
    epoch: 1,
    records,
    cursor: { count: frame!.count, historyHash: frame!.historyHash },
  });
  assert.equal(upToDate, null, "nothing new → no frame");
});

test("first frame is a full send; the standby applies and advances its cursor", async () => {
  const records = [base(1, 100), tool("t1", 1, 110)];
  const frame = buildReplFrame({ sessionId: "s", epoch: 1, records, checkpointCommit: "c1" })!;
  assert.equal(frame.mode, "full");
  assert.equal(frame.baseCount, 0);

  const state = initialReplState();
  const { deps, persisted, fetched } = recorder();
  const out = await applyReplFrame(state, frame, deps);
  assert.equal(out.status, "applied");
  assert.equal(state.records.length, 2);
  assert.equal(state.checkpointCommit, "c1");
  assert.deepEqual(fetched, ["c1"], "checkpoint objects fetched once");
  assert.equal(persisted.length, 1);
  if (out.status === "applied") assert.deepEqual(out.cursor, cursorOf(state));
});

test("a second turn ships only the new tail (append), applied onto the prefix", async () => {
  const turn1 = [base(1, 100)];
  const f1 = buildReplFrame({ sessionId: "s", epoch: 1, records: turn1, checkpointCommit: "c1" })!;
  const state = initialReplState();
  const { deps } = recorder();
  await applyReplFrame(state, f1, deps);

  const turn2 = [...turn1, tool("t1", 1, 200), base(2, 210)];
  const f2 = buildReplFrame({ sessionId: "s", epoch: 1, records: turn2, checkpointCommit: "c2", cursor: cursorOf(state) })!;
  assert.equal(f2.mode, "append");
  assert.equal(f2.baseCount, 1);
  assert.equal(f2.records.length, 2, "only the two new records travel");

  const out = await applyReplFrame(state, f2, deps);
  assert.equal(out.status, "applied");
  assert.equal(state.records.length, 3);
  assert.equal(state.checkpointCommit, "c2");
});

test("a gap (missed frame) is not applied blindly — it asks the owner to re-sync", async () => {
  const state: ReplState = { epoch: 1, records: [base(1, 100)], historyHash: "tok" };
  const { deps, persisted } = recorder();
  // Owner sends an append that begins at index 3 — the standby only has 1 record.
  const badFrame = {
    sessionId: "s",
    epoch: 1,
    mode: "append" as const,
    baseCount: 3,
    records: [base(4, 400)],
    count: 4,
    historyHash: "tok4",
  };
  const out = await applyReplFrame(state, badFrame, deps);
  assert.equal(out.status, "resync");
  if (out.status === "resync") assert.deepEqual(out.cursor, cursorOf(state));
  assert.equal(persisted.length, 0, "nothing persisted on a gap");
  assert.equal(state.records.length, 1, "state untouched");
});

test("divergence: a mismatched cursor makes the owner send a full frame that replaces", async () => {
  // Standby diverged (e.g. local compaction) — its token won't match the owner's.
  const ownerRecords = [base(1, 100), base(2, 200)];
  const frame = buildReplFrame({
    sessionId: "s",
    epoch: 1,
    records: ownerRecords,
    cursor: { count: 1, historyHash: "does-not-match" },
  })!;
  assert.equal(frame.mode, "full", "unrecognized prefix → full resend");

  const state: ReplState = { epoch: 1, records: [tool("stale", 0, 50)], historyHash: "does-not-match" };
  const { deps } = recorder();
  const out = await applyReplFrame(state, frame, deps);
  assert.equal(out.status, "applied");
  assert.equal(state.records.length, 2);
  assert.equal((state.records[0] as { bivyKind: string }).bivyKind, "base", "replica replaced wholesale");
});

test("fencing: a frame from a superseded owner (lower epoch) is rejected, state untouched", async () => {
  const state: ReplState = { epoch: 5, records: [base(1, 100)], historyHash: "tok", checkpointCommit: "c1" };
  const { deps, persisted } = recorder();
  const staleFrame = buildReplFrame({ sessionId: "s", epoch: 4, records: [base(1, 100), base(2, 200)] })!;
  const out = await applyReplFrame(state, staleFrame, deps);
  assert.equal(out.status, "stale");
  if (out.status === "stale") assert.equal(out.ownerEpoch, 5);
  assert.equal(persisted.length, 0);
  assert.equal(state.records.length, 1, "a demoted owner cannot advance the replica");
});

test("promotion: a frame at a higher epoch is honored and transfers ownership", async () => {
  const state: ReplState = { epoch: 5, records: [], historyHash: "" };
  const { deps } = recorder();
  const promoted = buildReplFrame({ sessionId: "s", epoch: 6, records: [base(1, 100)] })!;
  const out = await applyReplFrame(state, promoted, deps);
  assert.equal(out.status, "applied");
  assert.equal(state.epoch, 6, "the new owner's epoch is adopted");
});

test("both-or-neither: a checkpoint fetch failure aborts the frame — transcript replica unchanged", async () => {
  const state = initialReplState();
  const { deps, persisted } = recorder({ failCheckpoint: true });
  const frame = buildReplFrame({ sessionId: "s", epoch: 1, records: [base(1, 100)], checkpointCommit: "c1" })!;
  await assert.rejects(() => applyReplFrame(state, frame, deps), /git fetch failed/);
  assert.equal(persisted.length, 0, "transcript not persisted when the checkpoint fetch fails");
  assert.equal(state.records.length, 0, "state left untouched for a clean retry");
});

test("checkpoint objects are fetched only when the commit actually changes", async () => {
  const state = initialReplState();
  const { deps, fetched } = recorder();
  const f1 = buildReplFrame({ sessionId: "s", epoch: 1, records: [base(1, 100)], checkpointCommit: "c1" })!;
  await applyReplFrame(state, f1, deps);
  // Same checkpoint, only a transcript overlay changed → no second git fetch.
  const f2 = buildReplFrame({
    sessionId: "s",
    epoch: 1,
    records: [base(1, 100), tool("t1", 1, 150)],
    checkpointCommit: "c1",
    cursor: cursorOf(state),
  })!;
  await applyReplFrame(state, f2, deps);
  assert.deepEqual(fetched, ["c1"], "checkpoint fetched once, not per frame");
});
