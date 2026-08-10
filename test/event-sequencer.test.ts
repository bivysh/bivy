// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { SessionEventSequencer } from "../src/session/event-sequencer.js";

// Stamp N events for a session the way the fan-out does: next() then record().
function stamp(seq: SessionEventSequencer, id: string, n: number, bytes = 1): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const s = seq.next(id);
    seq.record(id, s, { n: s }, bytes);
    out.push(s);
  }
  return out;
}

// ---- monotonic per-session seq ---------------------------------------------
{
  const seq = new SessionEventSequencer();
  assert.deepEqual(stamp(seq, "a", 3), [1, 2, 3], "seq is 1-based and monotonic");
  assert.equal(seq.head("a"), 3, "head tracks the latest assigned seq");
  // Sessions are independent.
  assert.deepEqual(stamp(seq, "b", 2), [1, 2], "a second session starts its own count");
  assert.equal(seq.head("a"), 3);
  assert.equal(seq.head("unknown"), 0, "an unknown session has head 0");
}

// ---- replay serves the contiguous tail -------------------------------------
{
  const seq = new SessionEventSequencer();
  stamp(seq, "a", 5);
  const r = seq.replay("a", 2);
  assert.equal(r.mode, "replay");
  assert.equal(r.head, 5);
  assert.deepEqual((r as { events: { n: number }[] }).events.map((e) => e.n), [3, 4, 5], "replays everything after afterSeq, in order");
}

// ---- already-current client gets an empty replay ---------------------------
{
  const seq = new SessionEventSequencer();
  stamp(seq, "a", 4);
  const r = seq.replay("a", 4);
  assert.equal(r.mode, "replay");
  assert.deepEqual((r as { events: unknown[] }).events, [], "afterSeq === head → nothing missed");
  const ahead = seq.replay("a", 9);
  assert.equal(ahead.mode, "replay");
  assert.deepEqual((ahead as { events: unknown[] }).events, [], "afterSeq beyond head is still current, not an error");
}

// ---- eviction past the client's cursor forces a reset ----------------------
{
  const seq = new SessionEventSequencer({ maxEventsPerSession: 3 });
  stamp(seq, "a", 6); // only seq 4,5,6 retained; 1,2,3 evicted
  const served = seq.replay("a", 4);
  assert.equal(served.mode, "replay", "afterSeq at the oldest retained boundary is still serveable");
  assert.deepEqual((served as { events: { n: number }[] }).events.map((e) => e.n), [5, 6]);
  const reset = seq.replay("a", 2);
  assert.equal(reset.mode, "reset", "afterSeq older than the retained window can't be served → reset");
  assert.equal(reset.head, 6, "reset still reports head so the client knows where the stream is");
}

// ---- byte cap also evicts, but never below one entry -----------------------
{
  const seq = new SessionEventSequencer({ maxBytesPerSession: 10 });
  stamp(seq, "a", 20, 5); // 5 bytes each, cap 10 → keeps ~2 newest
  const r = seq.replay("a", 19);
  assert.equal(r.mode, "replay");
  assert.deepEqual((r as { events: { n: number }[] }).events.map((e) => e.n), [20], "head is always retained under the byte cap");
  assert.equal(seq.replay("a", 0).mode, "reset", "an old cursor resets once the byte cap has evicted the head-1 range");
}

// ---- drop forgets the ring --------------------------------------------------
{
  const seq = new SessionEventSequencer();
  stamp(seq, "a", 3);
  seq.drop("a");
  assert.equal(seq.head("a"), 0, "a dropped session's head resets");
  assert.deepEqual((seq.replay("a", 0) as { events: unknown[] }).events, [], "a dropped session replays empty (head 0, current)");
}

console.log("event-sequencer: all tests passed");
