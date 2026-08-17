// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Per-session event sequencing + a bounded replay buffer — the node side of
// lossless live delivery.
//
// Today the node→relay uplink (relay-client.ts sendEvent) DROPS a session event
// whenever its socket isn't OPEN, and the relay→client hop can lose a chunked
// frame — with no way for a client to notice, because live `session.event`
// frames carry no ordering token. The only recovery is pull-based transcript
// catch-up (history-sync.ts), which recovers the persisted transcript but NOT
// the transient stream events (message_update deltas, tool cards) that never
// entered the durable EventLog.
//
// This module gives every fanned-out `session.event` a monotonic per-session
// `seq` and keeps a bounded, CONTIGUOUS ring of the recent ones. A client that
// detects a gap (or reconnects) asks to `replay` from the last seq it holds; the
// node returns the buffered tail, or signals `reset` when its buffer has already
// evicted past that point (the client then falls back to a full history sync).
//
// The ring is contiguous by construction: seqs run 1,2,3,…,head with no holes,
// and eviction only ever drops the OLDEST, so the retained range is always
// [oldest, head]. That is what lets the client reassemble in order. The fan-out
// already coalesces the burst of `message_update`s into ~one emit per tick
// (session-event-coalescer.ts), so only those coalesced emits are sequenced —
// the buffer holds turn-scale events, not every agent stdout line.
//
// Pure and dependency-free (no daemon knowledge); unit-tested in
// test/event-sequencer.test.ts.

export type ReplayOutcome =
  /** The buffer can serve everything after `afterSeq`. `events` may be empty
   *  (the client was already current). */
  | { mode: "replay"; head: number; events: unknown[] }
  /** The buffer has evicted past `afterSeq` (or the session is unknown): the
   *  client cannot be made whole from the ring and must full-resync via history. */
  | { mode: "reset"; head: number };

interface SessionRing {
  /** Highest seq assigned so far (0 before the first event). */
  head: number;
  /** Buffered payloads in ascending seq order; entry[i].seq === firstSeq + i. */
  entries: { seq: number; payload: unknown; bytes: number }[];
  /** Total bytes currently retained (sum of entries[].bytes), for the byte cap. */
  bytes: number;
}

export interface SessionEventSequencerOptions {
  /** Max buffered events retained per session (oldest evicted past this). */
  maxEventsPerSession?: number;
  /** Max buffered bytes retained per session (oldest evicted past this). */
  maxBytesPerSession?: number;
}

const DEFAULT_MAX_EVENTS = 1024;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

export class SessionEventSequencer {
  private readonly rings = new Map<string, SessionRing>();
  private readonly maxEvents: number;
  private readonly maxBytes: number;

  constructor(opts: SessionEventSequencerOptions = {}) {
    this.maxEvents = Math.max(1, opts.maxEventsPerSession ?? DEFAULT_MAX_EVENTS);
    this.maxBytes = Math.max(1, opts.maxBytesPerSession ?? DEFAULT_MAX_BYTES);
  }

  private ring(sessionId: string): SessionRing {
    let ring = this.rings.get(sessionId);
    if (!ring) {
      ring = { head: 0, entries: [], bytes: 0 };
      this.rings.set(sessionId, ring);
    }
    return ring;
  }

  /** Assign the next seq for a session (1-based, strictly monotonic). Call once
   *  per event, immediately before it is fanned out, so seq order === delivery
   *  order. Pair with `record` to retain the payload for replay. */
  next(sessionId: string): number {
    const ring = this.ring(sessionId);
    ring.head += 1;
    return ring.head;
  }

  /** Retain a fanned-out payload (already stamped with `seq`) for replay. `seq`
   *  must be the value `next()` just returned for this session, so the ring stays
   *  contiguous. `bytes` is a best-effort size for the byte cap. */
  record(sessionId: string, seq: number, payload: unknown, bytes = 0): void {
    const ring = this.ring(sessionId);
    // Only accept the contiguous next entry; anything else would punch a hole
    // that breaks reset detection, so drop it defensively rather than corrupt the
    // ring (callers always record right after next(), so this never fires).
    const expected = ring.entries.length ? ring.entries[ring.entries.length - 1].seq + 1 : ring.head;
    if (seq !== expected && ring.entries.length) return;
    ring.entries.push({ seq, payload, bytes: Math.max(0, bytes) });
    ring.bytes += Math.max(0, bytes);
    this.evict(ring);
  }

  /** Evict oldest entries until within both caps, but always keep at least the
   *  newest entry so `head` can still be served. */
  private evict(ring: SessionRing): void {
    while (ring.entries.length > 1 && (ring.entries.length > this.maxEvents || ring.bytes > this.maxBytes)) {
      const dropped = ring.entries.shift();
      if (dropped) ring.bytes -= dropped.bytes;
    }
  }

  /** Highest seq assigned for a session (0 if none) — the live-stream head a
   *  client baselines against after a history sync. */
  head(sessionId: string): number {
    return this.rings.get(sessionId)?.head ?? 0;
  }

  /**
   * Serve the events a client is missing. `afterSeq` is the last contiguous seq
   * the client holds; the client wants everything with seq > afterSeq.
   *  - already current (`afterSeq >= head`) → `replay` with no events.
   *  - the ring still holds seq `afterSeq + 1` → `replay` with the contiguous tail.
   *  - the ring has evicted past `afterSeq + 1` (or the session is unknown) →
   *    `reset`: the client must full-resync from history instead.
   */
  replay(sessionId: string, afterSeq: number): ReplayOutcome {
    const ring = this.rings.get(sessionId);
    const head = ring?.head ?? 0;
    if (!ring || afterSeq >= head) return { mode: "replay", head, events: [] };
    const oldest = ring.entries.length ? ring.entries[0].seq : head + 1;
    // The next seq the client needs is afterSeq + 1. If that's older than the
    // oldest we retain, there's an unrecoverable hole → reset.
    if (afterSeq + 1 < oldest) return { mode: "reset", head };
    const events = ring.entries.filter((e) => e.seq > afterSeq).map((e) => e.payload);
    return { mode: "replay", head, events };
  }

  /** Forget a session's ring (on close/delete) so it doesn't leak. */
  drop(sessionId: string): void {
    this.rings.delete(sessionId);
  }
}
