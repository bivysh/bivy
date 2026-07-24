// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
//
// A supervised, self-healing connection with exponential backoff + jitter — the
// reliability layer under the sibling replication transport
// (docs/session-replication.md, follow-up #2). Without it, warm replication is
// only as reliable as the socket at each individual turn boundary: a relay blip
// or a standby restart silently pauses replication until the next turn happens to
// reconnect, and repeated failures surface nothing. This keeps exactly one live
// connection to the standby, reconnecting on drop so the standby stays warm.
//
// Generic + transport-free (the connect/close and the clock are injected), so the
// backoff/state machine unit-tests without a real socket, mirroring
// session-event-coalescer.ts. `ReplicationService` wires a `SiblingClient` into it.
//
// Backoff shape: a CONNECT failure backs off (base·factor^attempt, capped, with
// jitter); a DROP after a healthy connection resets the counter so reconnection is
// prompt (one base delay) rather than treating a long-lived session that finally
// dropped as if it had been flapping.

export interface BackoffOptions {
  /** Delay before the first retry. */
  baseMs?: number;
  /** Exponential growth per consecutive failure. */
  factor?: number;
  /** Ceiling on the delay. */
  maxMs?: number;
  /** Fractional jitter (0..1): the delay is spread ±jitter/2 around the target. */
  jitter?: number;
}

export interface ReconnectClock {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  /** In [0,1); injected so jittered delays are deterministic under test. */
  random: () => number;
}

const defaultClock: ReconnectClock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  random: () => Math.random(),
};

export interface ReconnectingConnectionOptions<T> {
  /**
   * Establish a connection. The supervisor passes an `onDrop` callback that the
   * connection MUST invoke when it closes/errors, so the supervisor learns the
   * connection died and can reconnect. Must reject if the connection can't be
   * established.
   */
  connect: (onDrop: (err?: unknown) => void) => Promise<T>;
  /** Close a live connection (on stop, or when a new one supersedes it). */
  close: (conn: T) => void;
  /** A fresh connection became live. */
  onActive?: (conn: T) => void;
  /** A live connection dropped (before the reconnect is scheduled). */
  onDrop?: (err?: unknown) => void;
  /** A connect attempt failed; `nextDelayMs` is when the next try is scheduled. */
  onRetry?: (err: unknown, nextDelayMs: number) => void;
  backoff?: BackoffOptions;
  clock?: ReconnectClock;
}

interface Waiter<T> {
  resolve: (conn: T | undefined) => void;
  timer: unknown;
}

export class ReconnectingConnection<T> {
  private conn?: T;
  private attempt = 0; // consecutive CONNECT failures
  private timer?: unknown;
  private connecting = false;
  private stopped = false;
  private readonly waiters: Waiter<T>[] = [];

  private readonly base: number;
  private readonly factor: number;
  private readonly max: number;
  private readonly jitter: number;
  private readonly clock: ReconnectClock;

  constructor(private readonly opts: ReconnectingConnectionOptions<T>) {
    this.base = opts.backoff?.baseMs ?? 1000;
    this.factor = opts.backoff?.factor ?? 2;
    this.max = opts.backoff?.maxMs ?? 30_000;
    this.jitter = Math.min(1, Math.max(0, opts.backoff?.jitter ?? 0.3));
    this.clock = opts.clock ?? defaultClock;
  }

  /** The live connection, or undefined while (re)connecting. */
  current(): T | undefined {
    return this.conn;
  }

  /** Begin connecting (idempotent). */
  start(): void {
    if (this.stopped) return;
    this.kick();
  }

  /**
   * Resolve with the live connection, triggering a connect if idle and waiting up
   * to `timeoutMs`. Resolves `undefined` if it isn't up in time — the caller skips
   * this round while the supervisor keeps reconnecting in the background (the
   * log-based replicator simply ships the accumulated delta on a later turn).
   */
  ensure(timeoutMs: number): Promise<T | undefined> {
    if (this.conn) return Promise.resolve(this.conn);
    if (this.stopped) return Promise.resolve(undefined);
    this.start();
    return new Promise<T | undefined>((resolve) => {
      const waiter: Waiter<T> = {
        resolve,
        timer: this.clock.setTimeout(() => {
          this.removeWaiter(waiter);
          resolve(undefined);
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  /** Stop for good: cancel timers, fail waiters, and close any live connection. */
  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) {
      this.clock.clearTimeout(this.timer);
      this.timer = undefined;
    }
    while (this.waiters.length) {
      const w = this.waiters.pop()!;
      this.clock.clearTimeout(w.timer);
      w.resolve(undefined);
    }
    if (this.conn !== undefined) {
      try {
        this.opts.close(this.conn);
      } catch {
        /* ignore */
      }
      this.conn = undefined;
    }
  }

  // --- internals -----------------------------------------------------------

  private kick(): void {
    if (this.stopped || this.connecting || this.conn !== undefined) return;
    this.connecting = true;
    this.opts
      .connect((err) => this.handleDrop(err))
      .then((conn) => {
        this.connecting = false;
        if (this.stopped) {
          try {
            this.opts.close(conn);
          } catch {
            /* ignore */
          }
          return;
        }
        this.conn = conn;
        this.attempt = 0; // healthy again → next drop reconnects promptly
        this.opts.onActive?.(conn);
        this.flushWaiters(conn);
      })
      .catch((err) => {
        this.connecting = false;
        this.scheduleRetry(err);
      });
  }

  private handleDrop(err?: unknown): void {
    // Only act on the drop of the connection we currently consider live.
    if (this.conn === undefined) return;
    this.conn = undefined;
    this.opts.onDrop?.(err);
    // attempt was reset to 0 on the last successful connect, so this schedules one
    // base-delay retry rather than an immediate hot-loop reconnect.
    this.scheduleRetry(err);
  }

  private scheduleRetry(err: unknown): void {
    if (this.stopped || this.timer !== undefined || this.connecting) return;
    const delay = this.delayFor(this.attempt);
    this.attempt += 1;
    this.opts.onRetry?.(err, delay);
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      this.kick();
    }, delay);
  }

  private delayFor(attempt: number): number {
    const raw = Math.min(this.max, this.base * Math.pow(this.factor, attempt));
    // Spread ±jitter/2 around the target: with jitter=0.3 the delay is 85%–115%.
    const spread = raw * this.jitter * (this.clock.random() - 0.5);
    return Math.max(0, Math.round(raw + spread));
  }

  private flushWaiters(conn: T): void {
    while (this.waiters.length) {
      const w = this.waiters.pop()!;
      this.clock.clearTimeout(w.timer);
      w.resolve(conn);
    }
  }

  private removeWaiter(waiter: Waiter<T>): void {
    const i = this.waiters.indexOf(waiter);
    if (i >= 0) this.waiters.splice(i, 1);
  }
}
