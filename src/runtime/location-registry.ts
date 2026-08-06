// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

/**
 * Generic keyed location registry — the shared primitive behind Stage 2's
 * externalizable indexes (docs/agent-node-decoupling.md). Sessions map
 * `sessionId → agent-service address` (session-location.ts); terminals map
 * `sessionId → { termId }`; both are the same shape: a small async key→value
 * store the daemon reads on a local miss and a shared (control-plane-backed)
 * implementation can later replace behind the same interface.
 *
 * Async by design so a networked backing drops in without touching call sites.
 * Dependency-free and unit-testable, in the style of backpressure.ts.
 */

export interface LocationRegistry<V> {
  record(key: string, value: V): Promise<void>;
  lookup(key: string): Promise<V | undefined>;
  forget(key: string): Promise<void>;
}

/**
 * Node-local registry: each daemon knows only its own entries. This is exactly
 * today's behavior (no cross-daemon sharing) and the safe default while the flag
 * is off. A shared implementation replaces it to unlock statelessness — same
 * interface, so no call site changes. Values are shallow-copied in and out so a
 * caller's later mutation can't alias a stored entry.
 */
export class InMemoryLocationRegistry<V extends object> implements LocationRegistry<V> {
  private readonly byKey = new Map<string, V>();

  async record(key: string, value: V): Promise<void> {
    if (!key) throw new Error("location key is required");
    this.byKey.set(key, { ...value });
  }

  async lookup(key: string): Promise<V | undefined> {
    const found = this.byKey.get(key);
    return found ? { ...found } : undefined;
  }

  async forget(key: string): Promise<void> {
    this.byKey.delete(key);
  }

  /** Number of recorded entries (test/introspection aid). */
  get size(): number {
    return this.byKey.size;
  }
}
