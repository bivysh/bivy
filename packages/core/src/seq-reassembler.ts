// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Client-side ordered reassembly of sequenced `session.event`s — the consumer of
// the node's per-session `seq` (docs/session-reliability-plan.md, Phase 2).
//
// The node stamps each fanned-out session event with a monotonic per-session
// `seq` (see src/session/event-sequencer.ts) and keeps a bounded replay buffer.
// This is the client's TCP-like receiver: it applies events strictly in order,
// drops duplicates/replays it has already seen, holds a forward event when a
// gap opens (so a missed tool card can't be overtaken by later streamed text),
// and tells the caller which seq to `replay` from to fill the hole. When too
// many events pile up behind a gap it reports `overflow` so the caller can fall
// back to a full history resync instead of buffering unboundedly.
//
// Stream identity (the node's `epoch`, which changes on a node restart) is
// handled by the caller: on a new epoch it calls `reset()` before feeding
// events, so this stays a pure ordering primitive with no notion of restarts.
//
// Pure and framework-agnostic; unit-tested in test/seq-reassembler.test.ts.

export interface ReassembleResult {
  /** Events ready to apply now, already in contiguous seq order. */
  ready: unknown[];
  /** Present when a gap is open: ask the node to replay after this seq. */
  gapFrom?: number;
  /** The held buffer exceeded its cap — abandon reassembly and full-resync. */
  overflow?: boolean;
}

export interface SeqReassemblerOptions {
  /** Max out-of-order events held behind a gap before signalling overflow. */
  maxHeld?: number;
}

const DEFAULT_MAX_HELD = 512;

export class SeqReassembler {
  /** Next contiguous seq we expect; 0 means "not yet initialised". */
  private nextSeq = 0;
  private readonly held = new Map<number, unknown>();
  private readonly maxHeld: number;

  constructor(opts: SeqReassemblerOptions = {}) {
    this.maxHeld = Math.max(1, opts.maxHeld ?? DEFAULT_MAX_HELD);
  }

  /**
   * Baseline against a history sync: we've applied everything through `headSeq`,
   * so the next live event we expect is `headSeq + 1`. Forward-only WITHIN a
   * stream (epoch) — never rewinds past events already applied, so a history
   * reply that races a live event can't cause a duplicate. A node restart is a
   * new epoch and the caller `reset()`s first, so `nextSeq` starts from 0 there.
   */
  baseline(headSeq: number): void {
    const want = (Number.isFinite(headSeq) ? Math.max(0, Math.floor(headSeq)) : 0) + 1;
    if (want > this.nextSeq) this.nextSeq = want;
    for (const s of [...this.held.keys()]) if (s < this.nextSeq) this.held.delete(s);
  }

  /**
   * Feed one sequenced event. Returns the events that are now safe to apply in
   * order (possibly none, possibly several once a held run drains).
   *  - unsequenced (`seq` not a finite number, e.g. an older node) → pass through.
   *  - not yet initialised → adopt this seq as the start of the stream.
   *  - `seq < next` → duplicate/replayed → drop.
   *  - `seq === next` → apply, then drain any contiguous held events.
   *  - `seq > next` → hold it and report the gap (`gapFrom`), or `overflow`.
   */
  accept(seq: unknown, event: unknown): ReassembleResult {
    if (typeof seq !== "number" || !Number.isFinite(seq)) return { ready: [event] };
    const s = Math.floor(seq);
    if (this.nextSeq === 0) {
      this.nextSeq = s + 1;
      return { ready: [event] };
    }
    if (s < this.nextSeq) return { ready: [] };
    if (s > this.nextSeq) {
      this.held.set(s, event);
      if (this.held.size > this.maxHeld) return { ready: [], overflow: true };
      return { ready: [], gapFrom: this.nextSeq - 1 };
    }
    const ready: unknown[] = [event];
    this.nextSeq += 1;
    while (this.held.has(this.nextSeq)) {
      ready.push(this.held.get(this.nextSeq));
      this.held.delete(this.nextSeq);
      this.nextSeq += 1;
    }
    return { ready };
  }

  /** Abandon all state (new stream epoch, or a full resync). */
  reset(): void {
    this.nextSeq = 0;
    this.held.clear();
  }

  /** The next contiguous seq expected (for tests/diagnostics). */
  get expected(): number {
    return this.nextSeq;
  }

  /** How many out-of-order events are currently held behind a gap. */
  get heldCount(): number {
    return this.held.size;
  }
}
