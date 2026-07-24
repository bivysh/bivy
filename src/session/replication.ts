// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
//
// Warm session replication — the transport-free DECISION core (Phase 1 of
// docs/session-replication.md).
//
// The goal: a standby node continuously mirrors a session's state so that if the
// owning node goes offline, the session can be *manually* promoted and continued
// elsewhere WITHOUT fetching anything from the (possibly dead) owner. Both halves
// of a session's state are already append-only, cursor-friendly logs, so warm
// replication is "tail two logs and ship their deltas":
//
//   - Transcript: the per-session `EventLog` (event-log.ts) is append-only JSONL.
//     We ship appended `LogRecord`s using the SAME count+hash cursor as the
//     client-facing incremental sync (history-sync.ts) — self-healing on a gap.
//   - Workspace: the Universal Agent Harness commits a git checkpoint per turn
//     (harness/checkpoint.ts). We ship the checkpoint commit sha; the standby
//     fetches the objects (git's own negotiation is idempotent + self-healing).
//
// Replication is anchored to the TURN/CHECKPOINT boundary so the two halves stay
// mutually consistent: every replicated frame carries the transcript tail AND the
// checkpoint that closed the same turn, and the standby applies BOTH or NEITHER.
// Recovery point = "the last completed turn"; a crash mid-turn loses at most the
// in-flight turn (the standby re-runs the last prompt on promotion).
//
// This module is the pure core — no relay, no disk, no git. Side effects (persist
// the tail, fetch the checkpoint objects) are injected, exactly like adoption.ts
// injects `attach`/`forget`, so the fencing/cursor/consistency logic unit-tests
// without a daemon (test/replication.test.ts). Transport, the control-plane epoch
// column, and the promotion command are layered on top (see the doc).

import { historyDelta, type HistoryMode } from "../history-sync.js";
import type { LogRecord } from "./event-log.js";

/** What a standby currently holds — echoed back to the owner to request a delta. */
export interface ReplCursor {
  /** Number of leading `LogRecord`s the standby has. */
  count: number;
  /** The opaque history token the owner returned for those records (history-sync). */
  historyHash: string;
  /** The git checkpoint commit the standby has already fetched, if any. */
  checkpointCommit?: string;
}

/** One replication frame: a consistent (transcript-tail, checkpoint) pair. */
export interface ReplFrame {
  sessionId: string;
  /**
   * Ownership epoch. Monotonic; bumped by the control-plane compare-and-set when a
   * standby is promoted. A frame from a demoted owner (lower epoch) is fenced out.
   */
  epoch: number;
  /** Opaque runtime resume token to replicate in the envelope (for native resume). */
  runtimeSessionRef?: string;
  /** The git checkpoint that closed this turn; undefined for a transcript-only tick. */
  checkpointCommit?: string;
  // --- transcript delta (history-sync shape, over LogRecord[]) ---
  mode: HistoryMode;
  /** Index the `records` begin at (0 for a full send). */
  baseCount: number;
  /** The records to apply: the full list, or just the new tail. */
  records: LogRecord[];
  /** Total record count after the standby applies this frame. */
  count: number;
  /** Opaque token over all `count` records; the standby stores and echoes it. */
  historyHash: string;
}

/** The standby's durable view of a replicated session. */
export interface ReplState {
  epoch: number;
  records: LogRecord[];
  /** Token over `records` — the cursor the standby echoes to the owner. */
  historyHash: string;
  checkpointCommit?: string;
  runtimeSessionRef?: string;
}

/** A fresh, empty standby state (before the first frame). */
export function initialReplState(): ReplState {
  return { epoch: 0, records: [], historyHash: "" };
}

/** The cursor a standby advertises to its owner, derived from its state. */
export function cursorOf(state: ReplState): ReplCursor {
  return { count: state.records.length, historyHash: state.historyHash, checkpointCommit: state.checkpointCommit };
}

/**
 * OWNER side: build the frame to send a standby, given the cursor the standby last
 * advertised. Returns `null` when the standby is already up to date (no new records
 * AND the same checkpoint) so the owner skips an empty send. The transcript delta
 * reuses `historyDelta`, so a diverged/behind standby self-heals: a matching prefix
 * yields an `append`, anything else a `full`.
 */
export function buildReplFrame(input: {
  sessionId: string;
  epoch: number;
  records: readonly LogRecord[];
  checkpointCommit?: string;
  runtimeSessionRef?: string;
  cursor?: ReplCursor;
}): ReplFrame | null {
  const { sessionId, epoch, records, checkpointCommit, runtimeSessionRef, cursor } = input;
  const delta = historyDelta(records as unknown[], { have: cursor?.count, haveToken: cursor?.historyHash });
  const checkpointUnchanged = (checkpointCommit ?? undefined) === (cursor?.checkpointCommit ?? undefined);
  // Nothing new: an append that carries no records and no newer checkpoint.
  if (delta.mode === "append" && delta.messages.length === 0 && checkpointUnchanged) return null;
  return {
    sessionId,
    epoch,
    runtimeSessionRef,
    checkpointCommit,
    mode: delta.mode,
    baseCount: delta.baseCount,
    records: delta.messages as LogRecord[],
    count: delta.count,
    historyHash: delta.historyHash,
  };
}

/** Injected side effects for applying a frame on the standby. */
export interface ApplyDeps {
  /** Persist the session's authoritative record list (write the JSONL replica). */
  persist: (sessionId: string, records: LogRecord[]) => void | Promise<void>;
  /**
   * Fetch/checkout the git objects for a checkpoint commit into the standby's
   * replica worktree. Called BEFORE persisting the transcript so a git failure
   * aborts the whole frame (both-or-neither). Omit when worktree sync is disabled.
   */
  fetchCheckpoint?: (sessionId: string, commit: string) => void | Promise<void>;
}

export type ApplyOutcome =
  /** Frame applied; `cursor` is the new value to advertise back to the owner. */
  | { status: "applied"; cursor: ReplCursor }
  /** Couldn't append onto a gap; re-advertise `cursor` so the owner re-sends. */
  | { status: "resync"; cursor: ReplCursor }
  /** Frame came from a superseded owner (lower epoch); rejected, state untouched. */
  | { status: "stale"; ownerEpoch: number };

/**
 * STANDBY side: apply one frame, mutating `state` in place ONLY after every injected
 * side effect has succeeded (so a git/persist failure leaves the replica unchanged
 * and the frame is safely retried). Never advances past a gap — it asks the owner to
 * re-send instead, which `buildReplFrame` resolves to an `append` or a `full`.
 *
 * Fencing (the split-brain guard): a frame whose epoch is BELOW the state's is a
 * write from an owner that has already been superseded by a promotion — rejected.
 * A frame at or above the state's epoch is honored, and applying it adopts the
 * (possibly higher) epoch, so a promoted owner's first frame transfers ownership.
 */
export async function applyReplFrame(state: ReplState, frame: ReplFrame, deps: ApplyDeps): Promise<ApplyOutcome> {
  if (frame.epoch < state.epoch) return { status: "stale", ownerEpoch: state.epoch };

  // Decide the next record list without mutating state yet.
  let nextRecords: LogRecord[];
  if (frame.mode === "full") {
    nextRecords = [...frame.records];
  } else {
    // append — only valid when the frame continues exactly where we are.
    if (frame.baseCount !== state.records.length) {
      return { status: "resync", cursor: cursorOf(state) };
    }
    nextRecords = state.records.concat(frame.records);
  }

  // Git first: if it throws, we abort before touching the transcript replica.
  const nextCheckpoint = frame.checkpointCommit ?? state.checkpointCommit;
  if (frame.checkpointCommit && frame.checkpointCommit !== state.checkpointCommit && deps.fetchCheckpoint) {
    await deps.fetchCheckpoint(frame.sessionId, frame.checkpointCommit);
  }
  await deps.persist(frame.sessionId, nextRecords);

  // Commit the new view atomically now that all effects have landed.
  state.records = nextRecords;
  state.historyHash = frame.historyHash;
  state.checkpointCommit = nextCheckpoint;
  if (frame.runtimeSessionRef !== undefined) state.runtimeSessionRef = frame.runtimeSessionRef;
  state.epoch = Math.max(state.epoch, frame.epoch);
  return { status: "applied", cursor: cursorOf(state) };
}
