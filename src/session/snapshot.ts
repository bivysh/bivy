// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Node-independent, encrypted SESSION SNAPSHOT (Gap B in docs/ephemeral-sessions.md).
//
// Warm replication (replicator.ts) ships a session's state node→node so a live
// standby can take over — but that copy evaporates if every node goes away, which
// is exactly the destroy-lane ephemeral case (Fly Machines/Hetzner/EC2 that are
// torn down when the agent finishes). This reuses the SAME replication frame
// (full transcript + git checkpoint bundle + runtimeSessionRef) but seals it under
// the session room key and stores it as an opaque control-plane BLOB, so a
// torn-down session can be rebuilt onto a fresh machine later. The control plane
// only ever sees ciphertext — same posture as the E2E session title.
//
// This module is the pure build/apply core (injected deps, no daemon/relay), so
// it's unit-testable like replicator.ts; the daemon wires the real EventLog /
// checkpoint deps, the room key from relay.json, and the control-plane transport.

import { OwnerReplicator, StandbyApplier, type OwnerReplicatorDeps, type StandbyApplierDeps, type ReplWireFrame } from "./replicator.js";
import { seal, open } from "../e2e.js";

/**
 * Build a full, sealed snapshot of a session: a complete replication frame (ALL
 * transcript records + a full git checkpoint bundle + the runtime resume token),
 * serialized and encrypted under the session room key. Returns null when there's
 * nothing to snapshot yet (no records and no checkpoint).
 *
 * A fresh `OwnerReplicator` has no cursor, so `buildTurnFrame` produces a FULL
 * frame + full bundle — exactly what a from-scratch rebuild on a new machine
 * needs (it holds no base to delta against).
 */
export async function buildSessionSnapshot(sessionId: string, roomKey: Buffer, deps: OwnerReplicatorDeps): Promise<string | null> {
  const owner = new OwnerReplicator({ ...deps, worktreeSync: () => true });
  const frame = await owner.buildTurnFrame(sessionId);
  // Nothing worth persisting yet: no transcript and no checkpoint (a fresh owner
  // has no cursor, so buildReplFrame emits a zero-record frame rather than null).
  if (!frame || (frame.records.length === 0 && !frame.checkpointCommit)) return null;
  return seal(roomKey, JSON.stringify(frame));
}

export interface AppliedSnapshot {
  /** The runtime's opaque resume token from the source machine. Not sufficient
   *  alone on a fresh box (it names an on-disk store that won't exist) — the
   *  caller reconstructs a resumable runtime from the restored transcript. */
  runtimeSessionRef?: string;
  recordCount: number;
  checkpointCommit?: string;
}

/**
 * Decrypt and apply a sealed snapshot onto a fresh machine: rewrite the session's
 * EventLog transcript, land the git checkpoint into the (replica) repo and
 * materialize the working tree, and return the runtimeSessionRef so the caller
 * can re-derive a resumable runtime session (writeHistory / seeded fallback).
 * Throws on a bad key / corrupt blob, or if the frame can't apply cleanly.
 */
export async function applySessionSnapshot(sealed: string, roomKey: Buffer, deps: StandbyApplierDeps): Promise<AppliedSnapshot> {
  const frame = JSON.parse(open(roomKey, sealed)) as ReplWireFrame;
  const applier = new StandbyApplier(deps);
  const ack = await applier.receive(frame);
  // We always ship a FULL frame + full bundle, so a fresh applier applies it
  // outright ("applied"); "resync" is a benign already-current signal. A
  // "needFull"/"stale" here means a corrupt/foreign blob.
  if (ack.status !== "applied" && ack.status !== "resync") {
    throw new Error(`snapshot apply failed: ${ack.status}`);
  }
  return {
    runtimeSessionRef: frame.runtimeSessionRef,
    recordCount: frame.records.length,
    checkpointCommit: frame.checkpointCommit,
  };
}
