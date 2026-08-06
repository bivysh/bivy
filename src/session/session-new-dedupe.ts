// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Idempotency for `session.new`, keyed by the client's requestId.
//
// Mobile Safari can silently drop a backgrounded PWA's WebSocket reply without
// ever closing the socket, so the `session.history` answer to a `session.new`
// never reaches the client and its view wedges on the opening spinner. The
// client recovers by re-firing the SAME `session.new` (same requestId) once it
// reconnects. To make that retry safe, creation is deduped by requestId: a
// concurrent or later request carrying a requestId we've already handled adopts
// the session the first request created instead of spawning a duplicate.
//
// The in-flight Promise is stored synchronously (before any await), so a retry
// that races the original still joins it rather than creating a second session.

export interface SessionNewDedupeOptions {
  /** How long a fulfilled entry is retained so a later retry of the same
   *  requestId adopts the existing session. Long enough to cover a realistic
   *  background → foreground → reconnect window. Default 10 minutes. */
  ttlMs?: number;
  /** Schedule a fulfilled entry's eviction. Injected in tests for deterministic
   *  timing; defaults to an unref'd setTimeout so it never keeps the process
   *  alive. */
  schedule?: (fn: () => void, ms: number) => void;
}

export interface SessionNewDedupe<T> {
  /** Return the in-flight-or-recently-created result for `requestId`, else run
   *  `create()` and remember it. Without a requestId there's nothing to key on,
   *  so `create()` runs unconditionally. */
  run(requestId: string | undefined, create: () => Promise<T>): Promise<T>;
  /** Number of tracked entries (in-flight + not-yet-evicted). For tests/metrics. */
  size(): number;
}

export function createSessionNewDedupe<T>(options: SessionNewDedupeOptions = {}): SessionNewDedupe<T> {
  const ttlMs = options.ttlMs ?? 10 * 60_000;
  const schedule =
    options.schedule ??
    ((fn: () => void, ms: number) => {
      setTimeout(fn, ms).unref();
    });
  const inflight = new Map<string, Promise<T>>();

  function run(requestId: string | undefined, create: () => Promise<T>): Promise<T> {
    if (!requestId) return create();
    const existing = inflight.get(requestId);
    if (existing) return existing;
    const p = create();
    // Register synchronously so a retry racing the original joins this promise
    // rather than starting a second creation.
    inflight.set(requestId, p);
    p.then(
      () => schedule(() => inflight.delete(requestId), ttlMs),
      // A failed creation must not be cached: drop it immediately so a genuine
      // retry of the same requestId can attempt creation again.
      () => {
        inflight.delete(requestId);
      },
    );
    return p;
  }

  return { run, size: () => inflight.size };
}
