// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";

import { buildSessionSnapshot, applySessionSnapshot } from "../src/session/snapshot.js";
import { accountSealer, currentSealKey, mintSealKey, roomKeySealer, snapshotOpener, type SealKeyring } from "../src/session/seal-keys.js";
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
// The account's keyring, as every machine that can unwrap its vault holds it.
const ring: SealKeyring = mintSealKey({});
const current = currentSealKey(ring)!;
const sealer = accountSealer(current.kid, current.key);
const opener = snapshotOpener(ring, roomKey);

// A snapshot round-trips: build+seal on the source, then decrypt+apply on a
// DIFFERENT machine of the same account (its own room key) restores the full
// transcript, the git checkpoint, and the resume token.
{
  const records = [base(1), base(2), base(3)];
  const sealed = await buildSessionSnapshot("s1", sealer, ownerDeps(records, "sha-head"));
  assert.ok(sealed, "expected a snapshot");
  assert.ok(!sealed!.includes("turn 1"), "snapshot must be opaque ciphertext, not plaintext");

  const cap = standbyCapture();
  const applied = await applySessionSnapshot(sealed!, snapshotOpener(ring, randomBytes(32)), cap.deps);
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
  const sealed = await buildSessionSnapshot("s2", sealer, ownerDeps([], undefined));
  assert.equal(sealed, null);
}

// Only a holder of the account key can open it: another account's keyring
// can't, and neither can a machine that hasn't received the key yet.
{
  const sealed = await buildSessionSnapshot("s3", sealer, ownerDeps([base(1)], "sha"));
  assert.ok(sealed);
  const other = mintSealKey({});
  await assert.rejects(() => applySessionSnapshot(sealed!, snapshotOpener({ [current.kid]: other[Object.keys(other)[0]] }, roomKey), standbyCapture().deps));
  await assert.rejects(() => applySessionSnapshot(sealed!, snapshotOpener({}, roomKey), standbyCapture().deps), /doesn't hold the account key/);
}

// A snapshot sealed before account keys existed (room key, no prefix) still
// opens on the machine that wrote it.
{
  const sealed = await buildSessionSnapshot("legacy", roomKeySealer(roomKey), ownerDeps([base(1)], undefined));
  const applied = await applySessionSnapshot(sealed!, opener, standbyCapture().deps);
  assert.equal(applied.recordCount, 1);
}

// After a rotation (a machine was removed), new snapshots use the new key and
// older ones still open with the old key.
{
  const older = await buildSessionSnapshot("before", sealer, ownerDeps([base(1)], undefined));
  const rotated = mintSealKey(ring, Date.now() + 1000);
  const next = currentSealKey(rotated)!;
  assert.notEqual(next.kid, current.kid);
  const newer = await buildSessionSnapshot("after", accountSealer(next.kid, next.key), ownerDeps([base(2)], undefined));
  const rotatedOpener = snapshotOpener(rotated, randomBytes(32));
  assert.equal((await applySessionSnapshot(older!, rotatedOpener, standbyCapture().deps)).recordCount, 1);
  assert.equal((await applySessionSnapshot(newer!, rotatedOpener, standbyCapture().deps)).recordCount, 1);
  // The removed machine kept only the old ring: it can't read what came after.
  await assert.rejects(() => applySessionSnapshot(newer!, opener, standbyCapture().deps));
}

// Execution facts travel inside the seal; a mismatched session cannot write
// transcript/checkpoint state before identity validation.
{
  const sessionInfo = { runtimeId: "generic-agent", model: { provider: "provider", id: "model" }, name: "private title", sandbox: "read-only", approvalMode: "manual", credentialLabels: { provider: "work-account" } };
  const sealed = await buildSessionSnapshot("original", sealer, { ...ownerDeps([base(1)], undefined), sessionInfo: () => sessionInfo });
  assert.ok(sealed && !sealed.includes("private title"));
  const cap = standbyCapture();
  await assert.rejects(() => applySessionSnapshot(sealed!, opener, { ...cap.deps, expectedSessionId: "different" }), /identity mismatch/);
  assert.equal(cap.persisted.length, 0);
  const applied = await applySessionSnapshot(sealed!, opener, { ...cap.deps, expectedSessionId: "original" });
  assert.deepEqual(applied.sessionInfo, sessionInfo);
}

console.log("session-snapshot: all tests passed");
