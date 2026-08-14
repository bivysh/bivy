// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";

import { buildSessionSnapshot, applySessionSnapshot } from "../src/session/snapshot.js";
import type { OwnerReplicatorDeps, StandbyApplierDeps } from "../src/session/replicator.js";
import type { LogRecord } from "../src/session/event-log.js";

const base = (n: number): LogRecord => ({
  bivyKind: "base",
  reset: false,
  createdAt: n * 100,
  messages: [{ role: "assistant", content: [{ type: "text", text: `turn ${n}` }], timestamp: n * 100 }],
});

function ownerDeps(records: LogRecord[], head: string | undefined): OwnerReplicatorDeps {
  return {
    readRecords: () => records,
    epochOf: () => 3,
    checkpointHead: async () => head,
    bundleCheckpoint: async () => (head ? Buffer.from(`git-bundle@${head}`) : null),
    runtimeSessionRef: () => "claude-session-uuid-abc",
    worktreeSync: () => true,
  };
}

function standbyCapture() {
  const persisted: LogRecord[][] = [];
  const appliedBundles: string[] = [];
  const materialized: string[] = [];
  const deps: StandbyApplierDeps = {
    persistRecords: (_sid, r) => void persisted.push(r as LogRecord[]),
    applyBundle: async (_sid, buf) => { appliedBundles.push(buf.toString()); return { ok: true }; },
    materialize: async (sid) => void materialized.push(sid),
  };
  return { deps, persisted, appliedBundles, materialized };
}

const roomKey = randomBytes(32);

// A snapshot round-trips: build+seal on the source, then decrypt+apply on a fresh
// machine restores the full transcript, the git checkpoint, and the resume token.
{
  const records = [base(1), base(2), base(3)];
  const sealed = await buildSessionSnapshot("s1", roomKey, ownerDeps(records, "sha-head"));
  assert.ok(sealed, "expected a snapshot");
  assert.ok(!sealed!.includes("turn 1"), "snapshot must be opaque ciphertext, not plaintext");

  const cap = standbyCapture();
  const applied = await applySessionSnapshot(sealed!, roomKey, cap.deps);
  assert.equal(applied.recordCount, 3);
  assert.equal(applied.checkpointCommit, "sha-head");
  assert.equal(applied.runtimeSessionRef, "claude-session-uuid-abc");
  // The transcript was rewritten and the git checkpoint landed + materialized.
  assert.equal(cap.persisted.length, 1);
  assert.equal(cap.persisted[0].length, 3);
  assert.deepEqual(cap.appliedBundles, ["git-bundle@sha-head"]);
  assert.deepEqual(cap.materialized, ["s1"]);
}

// A snapshot with no transcript and no checkpoint yields nothing to store.
{
  const sealed = await buildSessionSnapshot("s2", roomKey, ownerDeps([], undefined));
  assert.equal(sealed, null);
}

// The wrong room key can't open the snapshot (E2E: only the account can read it).
{
  const sealed = await buildSessionSnapshot("s3", roomKey, ownerDeps([base(1)], "sha"));
  assert.ok(sealed);
  await assert.rejects(() => applySessionSnapshot(sealed!, randomBytes(32), standbyCapture().deps));
}

console.log("session-snapshot: all tests passed");
