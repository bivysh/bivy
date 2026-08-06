// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { strict as assert } from "node:assert";
import test from "node:test";

import { OwnerReplicator, StandbyApplier, type ReplWireFrame } from "../src/session/replicator.js";
import type { LogRecord } from "../src/session/event-log.js";

const base = (n: number, t: number): LogRecord => ({
  bivyKind: "base",
  reset: false,
  createdAt: t,
  messages: [{ role: "assistant", content: [{ type: "text", text: `turn ${n}` }], timestamp: t }],
});

/** A fake owner workspace: a growing transcript, a checkpoint sha, an epoch. */
function fakeOwner(opts: { worktreeSync?: boolean } = {}) {
  const records: LogRecord[] = [];
  let head: string | undefined;
  let epoch = 0;
  const bundles: Array<{ since?: string; head?: string }> = [];
  const owner = new OwnerReplicator({
    readRecords: () => records,
    epochOf: () => epoch,
    checkpointHead: async () => head,
    bundleCheckpoint: async (_sid, since) => {
      bundles.push({ since, head });
      return head ? Buffer.from(`bundle@${head}`) : null;
    },
    runtimeSessionRef: () => "/sessions/s.json",
    worktreeSync: () => opts.worktreeSync === true,
  });
  return {
    owner,
    bundles,
    turn(n: number, sha?: string) {
      records.push(base(n, n * 100));
      if (sha) head = sha;
    },
    setEpoch(e: number) { epoch = e; },
  };
}

/** A fake standby: records what it persisted and which bundles it "applied". */
function fakeStandby(opts: { missingBase?: boolean } = {}) {
  const persisted: LogRecord[][] = [];
  const applied: string[] = [];
  const materialized: string[] = [];
  const standby = new StandbyApplier({
    persistRecords: (_sid, r) => void persisted.push(r),
    applyBundle: async (_sid, buf) => {
      if (opts.missingBase) return { ok: false, needFull: true };
      applied.push(buf.toString());
      return { ok: true };
    },
    materialize: async (sid) => void materialized.push(sid),
  });
  return { standby, persisted, applied, materialized };
}

test("owner→standby round-trip: full first frame, then incremental, cursor advances", async () => {
  const o = fakeOwner();
  const s = fakeStandby();
  o.turn(1);

  const f1 = (await o.owner.buildTurnFrame("s"))!;
  assert.equal(f1.mode, "full");
  assert.equal(o.owner.applyAck("s", await s.standby.receive(f1)), false);
  assert.equal(s.persisted.at(-1)!.length, 1);
  assert.deepEqual(o.owner.cursor("s"), { count: 1, historyHash: f1.historyHash, checkpointCommit: undefined });

  o.turn(2);
  const f2 = (await o.owner.buildTurnFrame("s"))!;
  assert.equal(f2.mode, "append");
  assert.equal(f2.records.length, 1, "only the new turn travels");
  o.owner.applyAck("s", await s.standby.receive(f2));
  assert.equal(s.standby.state("s")!.records.length, 2);

  // Nothing new → no frame.
  assert.equal(await o.owner.buildTurnFrame("s"), null);
});

test("worktree sync attaches a git bundle; standby applies it and refreshes the tree", async () => {
  const o = fakeOwner({ worktreeSync: true });
  const s = fakeStandby();
  o.turn(1, "sha-c1");

  const f1 = (await o.owner.buildTurnFrame("s")) as ReplWireFrame;
  assert.ok(f1.bundle, "a bundle is attached when the checkpoint advanced");
  o.owner.applyAck("s", await s.standby.receive(f1));
  assert.deepEqual(s.applied, ["bundle@sha-c1"], "bundle applied on the standby");
  assert.deepEqual(s.materialized, ["s"], "working tree refreshed");

  // Second turn bundles incrementally against the acked checkpoint.
  o.turn(2, "sha-c2");
  await o.owner.buildTurnFrame("s");
  assert.equal(o.bundles.at(-1)!.since, "sha-c1", "incremental bundle since the last acked sha");
});

test("both-or-neither: a missing bundle prerequisite aborts the frame (needFull), transcript untouched", async () => {
  const o = fakeOwner({ worktreeSync: true });
  const s = fakeStandby({ missingBase: true });
  o.turn(1, "sha-c1");

  const f1 = (await o.owner.buildTurnFrame("s"))!;
  const ack = await s.standby.receive(f1);
  assert.equal(ack.status, "needFull");
  assert.equal(s.persisted.length, 0, "transcript NOT persisted when the bundle can't apply");
  assert.equal(s.standby.state("s")!.records.length, 0, "replica state untouched");
  // Owner drops its cursor and will resend a full frame next time.
  assert.equal(o.owner.applyAck("s", ack), true);
  assert.equal(o.owner.cursor("s"), undefined);
});

test("fencing: a frame from a superseded (lower-epoch) owner is rejected by the standby", async () => {
  const s = fakeStandby();
  // Standby already advanced to epoch 5 (a promotion happened).
  await s.standby.receive({
    sessionId: "s", epoch: 5, mode: "full", baseCount: 0,
    records: [base(1, 100)], count: 1, historyHash: "h1",
  });
  const ack = await s.standby.receive({
    sessionId: "s", epoch: 4, mode: "full", baseCount: 0,
    records: [base(1, 100), base(2, 200)], count: 2, historyHash: "h2",
  });
  assert.equal(ack.status, "stale");
  assert.equal(s.standby.state("s")!.records.length, 1, "a demoted owner cannot advance the replica");
});
