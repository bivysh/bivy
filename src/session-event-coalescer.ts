// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

/**
 * Coalesces high-frequency, self-superseding session events (assistant
 * `message_update`s) so the daemon serializes and fans them out at a bounded
 * rate instead of once per agent stdout line.
 *
 * Why this exists: the agent stream-json path emits a `message_update` per
 * output line, and each update carries the FULL accumulated assistant text so
 * far (not a delta). Broadcasting every one — a `JSON.stringify` locally plus an
 * encrypt+serialize for the relay — is O(n^2) work over a turn. Because a newer
 * update always supersedes the previous one, we keep only the latest per session
 * and emit it on a short timer, collapsing a burst of N updates into ~1 send per
 * tick with zero wire-contract change (clients still receive full-content
 * updates, just fewer of them).
 *
 * Ordering guarantee: any non-superseding event (tool_call, message_end, …) must
 * not jump ahead of streamed text already queued, so callers `flush()` the
 * pending update before emitting such an event.
 *
 * The timer is injectable so the behavior is unit-testable without real time.
 */

export interface CoalescerTimers<H> {
  schedule: (fn: () => void, ms: number) => H;
  cancel: (handle: H) => void;
}

const defaultTimers: CoalescerTimers<ReturnType<typeof setTimeout>> = {
  schedule: (fn, ms) => setTimeout(fn, ms),
  cancel: (h) => clearTimeout(h),
};

export interface SessionEventCoalescerOptions<H = ReturnType<typeof setTimeout>> {
  /** Max time a superseding update may wait before it is flushed. */
  coalesceMs: number;
  /** Emit a coalesced (droppable, full-content) payload — may apply backpressure. */
  emit: (payload: unknown) => void;
  /** Injectable clock; defaults to setTimeout/clearTimeout. */
  timers?: CoalescerTimers<H>;
}

export class SessionEventCoalescer<H = ReturnType<typeof setTimeout>> {
  private readonly pending = new Map<string, unknown>();
  private readonly timers = new Map<string, H>();
  private readonly coalesceMs: number;
  private readonly emit: (payload: unknown) => void;
  private readonly clock: CoalescerTimers<H>;

  constructor(opts: SessionEventCoalescerOptions<H>) {
    this.coalesceMs = opts.coalesceMs;
    this.emit = opts.emit;
    this.clock = opts.timers ?? (defaultTimers as unknown as CoalescerTimers<H>);
  }

  /** Queue a self-superseding update for `sessionId`, replacing any pending one. */
  push(sessionId: string, payload: unknown): void {
    this.pending.set(sessionId, payload);
    if (!this.timers.has(sessionId)) {
      this.timers.set(sessionId, this.clock.schedule(() => this.flush(sessionId), this.coalesceMs));
    }
  }

  /** Emit the pending update for `sessionId` immediately, if any. */
  flush(sessionId: string): void {
    this.cancelTimer(sessionId);
    if (this.pending.has(sessionId)) {
      const payload = this.pending.get(sessionId);
      this.pending.delete(sessionId);
      this.emit(payload);
    }
  }

  /** Drop any pending update and timer for `sessionId` without emitting (teardown). */
  clear(sessionId: string): void {
    this.cancelTimer(sessionId);
    this.pending.delete(sessionId);
  }

  /** Number of sessions with a pending update (test/introspection aid). */
  get size(): number {
    return this.pending.size;
  }

  private cancelTimer(sessionId: string): void {
    const handle = this.timers.get(sessionId);
    if (handle !== undefined) {
      this.clock.cancel(handle);
      this.timers.delete(sessionId);
    }
  }
}
