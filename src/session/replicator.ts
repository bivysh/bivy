// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
//
// Owner + standby ORCHESTRATION for warm session replication
// (docs/session-replication.md). This ties the pure decision core
// (replication.ts), the transcript log (event-log.ts), and the git checkpoint
// bundle (checkpoint-pack.ts) together behind an INJECTED transport, so the
// end-to-end flow is unit-testable without a relay, a daemon, or a second node
// (test/replicator.test.ts) — mirroring adoption.ts / backpressure.ts.
//
// Owner: on each turn boundary, build a frame from the transcript delta + (when
// worktree sync is on) a git bundle of the new checkpoint, and send it to the
// standby. Advance the per-standby cursor on ack; on a needFull/resync ack, drop
// the cursor so the next send is a full frame + full bundle (self-healing).
//
// Standby: apply each frame both-or-neither — the git bundle lands first (inside
// applyReplFrame's fetch step, so a missing prerequisite aborts before the
// transcript is touched), then the transcript, then the working tree is refreshed.

import {
  applyReplFrame,
  buildReplFrame,
  cursorOf,
  initialReplState,
  type ReplCursor,
  type ReplFrame,
  type ReplState,
} from "./replication.js";
import type { LogRecord } from "./event-log.js";

/** A frame plus its optional git checkpoint bundle (base64), as sent over the wire. */
export interface ReplWireFrame extends ReplFrame {
  /** base64 git bundle carrying the checkpoint commit(s); present when worktree sync is on. */
  bundle?: string;
}

/** The standby's reply, telling the owner how to advance (or reset) its cursor. */
export type ReplAck =
  | { status: "applied"; cursor: ReplCursor }
  | { status: "resync"; cursor: ReplCursor }
  | { status: "needFull"; cursor: ReplCursor }
  | { status: "stale"; ownerEpoch: number };

// ---------------------------------------------------------------------------
// Owner side
// ---------------------------------------------------------------------------

export interface OwnerReplicatorDeps {
  /** The session's full ordered transcript records (EventLog.entries). */
  readRecords: (sessionId: string) => LogRecord[] | Promise<LogRecord[]>;
  /** The current ownership epoch for the session (from control-plane ownership). */
  epochOf: (sessionId: string) => number | Promise<number>;
  /** The session's current checkpoint sha, or undefined if the workspace isn't git. */
  checkpointHead: (sessionId: string) => Promise<string | undefined>;
  /** Build a git bundle of the checkpoint since `sinceSha` (null = nothing new). */
  bundleCheckpoint: (sessionId: string, sinceSha?: string) => Promise<Buffer | null>;
  /** The runtime's opaque resume token (record.sessionFile), replicated for resume. */
  runtimeSessionRef?: (sessionId: string) => string | undefined;
  /** Whether workspace (git) replication is enabled for this session. */
  worktreeSync: () => boolean;
}

/**
 * Per-session owner replicator. Holds the cursor the standby last acked; produces
 * one wire frame per turn and applies acks. Transport is the caller's job: send
 * `buildTurnFrame(...)` to the standby and feed its reply to `applyAck(...)`.
 */
export class OwnerReplicator {
  private cursors = new Map<string, ReplCursor>();

  constructor(private readonly deps: OwnerReplicatorDeps) {}

  /** The cursor the standby has acknowledged for a session (undefined = cold). */
  cursor(sessionId: string): ReplCursor | undefined {
    return this.cursors.get(sessionId);
  }

  /**
   * Build the frame to send the standby for the current state, or `null` when the
   * standby is already up to date (no new transcript records and no new checkpoint).
   */
  async buildTurnFrame(sessionId: string): Promise<ReplWireFrame | null> {
    const cursor = this.cursors.get(sessionId);
    const [records, epoch] = await Promise.all([
      Promise.resolve(this.deps.readRecords(sessionId)),
      Promise.resolve(this.deps.epochOf(sessionId)),
    ]);
    const head = await this.deps.checkpointHead(sessionId);
    const frame = buildReplFrame({
      sessionId,
      epoch,
      records,
      checkpointCommit: head,
      runtimeSessionRef: this.deps.runtimeSessionRef?.(sessionId),
      cursor,
    });
    if (!frame) return null;
    let bundle: string | undefined;
    if (this.deps.worktreeSync() && head && head !== cursor?.checkpointCommit) {
      const buf = await this.deps.bundleCheckpoint(sessionId, cursor?.checkpointCommit);
      if (buf) bundle = buf.toString("base64");
    }
    return bundle ? { ...frame, bundle } : frame;
  }

  /**
   * Apply the standby's ack. Returns `true` when the owner should immediately
   * re-send (the standby asked for a full resync / full bundle) — the caller then
   * calls `buildTurnFrame` again, which now produces a full frame because the
   * cursor was dropped.
   */
  applyAck(sessionId: string, ack: ReplAck): boolean {
    if (ack.status === "applied") {
      this.cursors.set(sessionId, ack.cursor);
      return false;
    }
    if (ack.status === "resync" || ack.status === "needFull") {
      // Drop the cursor so the next frame is a full transcript + full bundle.
      this.cursors.delete(sessionId);
      return true;
    }
    // stale: this owner has been superseded by a promotion — stop replicating.
    return false;
  }

  /** Forget a session (closed/deleted/demoted). */
  forget(sessionId: string): void {
    this.cursors.delete(sessionId);
  }
}

// ---------------------------------------------------------------------------
// Standby side
// ---------------------------------------------------------------------------

export interface StandbyApplierDeps {
  /** Persist the session's authoritative replica transcript (EventLog.rewrite). */
  persistRecords: (sessionId: string, records: LogRecord[]) => void | Promise<void>;
  /** Apply a git bundle into the replica repo; returns needFull if a base is missing. */
  applyBundle: (sessionId: string, bundle: Buffer) => Promise<{ ok: true } | { ok: false; needFull: true }>;
  /** Check the replicated checkpoint out into the replica working tree. */
  materialize: (sessionId: string) => Promise<void>;
}

/** A sentinel so a missing-prerequisite bundle aborts the frame cleanly. */
class NeedFullError extends Error {}

/**
 * Per-session standby applier. Holds the replica `ReplState`; applies each wire
 * frame both-or-neither and returns the ack the owner needs. Fencing, gap-resync,
 * and the checkpoint-before-transcript ordering all come from applyReplFrame.
 */
export class StandbyApplier {
  private states = new Map<string, ReplState>();

  constructor(private readonly deps: StandbyApplierDeps) {}

  state(sessionId: string): ReplState | undefined {
    return this.states.get(sessionId);
  }

  async receive(frame: ReplWireFrame): Promise<ReplAck> {
    const state = this.states.get(frame.sessionId) ?? initialReplState();
    this.states.set(frame.sessionId, state);
    const bundleBuf = frame.bundle ? Buffer.from(frame.bundle, "base64") : undefined;
    try {
      const outcome = await applyReplFrame(state, frame, {
        persist: (sid, records) => this.deps.persistRecords(sid, records),
        // The checkpoint step (before persisting the transcript): land the git
        // objects, then refresh the working tree. A missing prerequisite throws
        // NeedFull so the whole frame aborts without touching the transcript.
        fetchCheckpoint: bundleBuf
          ? async (sid) => {
              const res = await this.deps.applyBundle(sid, bundleBuf);
              if (!res.ok) throw new NeedFullError();
              await this.deps.materialize(sid);
            }
          : undefined,
      });
      if (outcome.status === "applied") return { status: "applied", cursor: outcome.cursor };
      if (outcome.status === "resync") return { status: "resync", cursor: outcome.cursor };
      return { status: "stale", ownerEpoch: outcome.ownerEpoch };
    } catch (err) {
      if (err instanceof NeedFullError) return { status: "needFull", cursor: cursorOf(state) };
      throw err;
    }
  }

  /** Forget a session's replica state (deleted, or promoted to live locally). */
  forget(sessionId: string): void {
    this.states.delete(sessionId);
  }
}
