// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

/**
 * Session-location registry — the Stage 2 seam (docs/agent-node-decoupling.md).
 *
 * Stage 1 moved the agent's process off the daemon; Stage 2 makes the daemon
 * stateless by letting ANY daemon instance serve ANY session. The missing piece
 * is a shared map from a session to the agent service that hosts it — a
 * generalization of the control plane's existing `sessionId → nodeId` index
 * (services/control-plane/src/store.ts) with the agent-service address added.
 *
 * This module defines the seam and a node-local default. Today the daemon holds
 * the live handle in `openSessions` (src/server.ts) and resumes from local disk
 * on a miss; with a shared implementation of this interface, a miss instead
 * resolves the session's agent-service address and re-attaches to the still-live
 * session via `RemoteRuntime.attachSession` (the Stage 1 `attach` op) — no local
 * handle, no local disk. The interface is async so a control-plane-backed
 * implementation (an HTTP round-trip) drops in behind the same flag without
 * touching call sites.
 *
 * Kept dependency-free and unit-testable, in the style of
 * services/relay/src/backpressure.ts.
 */

import { InMemoryLocationRegistry } from "./location-registry.js";

export interface SessionLocation {
  sessionId: string;
  /** Agent-service address hosting the session (see remote.ts connectSocketTransport). */
  agentServiceAddress: string;
  /** The runtime id running there (e.g. "claude-code-sdk"). */
  runtimeId: string;
  /** Owning node (generalizes the control plane's sessionId → nodeId). Optional. */
  nodeId?: string;
  /** Sandbox tier the session was pinned to, if any. */
  sandbox?: string;
  /** Free-form last-updated marker (caller-supplied; e.g. an ISO timestamp). */
  updatedAt?: string;
}

export interface SessionLocationRegistry {
  /** Record (or replace) where a session is hosted. */
  record(location: SessionLocation): Promise<void>;
  /** Resolve where a session is hosted, or undefined if unknown. */
  lookup(sessionId: string): Promise<SessionLocation | undefined>;
  /** Drop a session's mapping (on explicit close/dispose). */
  forget(sessionId: string): Promise<void>;
}

/**
 * Node-local registry: each daemon knows only its own sessions. This is exactly
 * today's behavior (no cross-daemon routing) and the safe default while the flag
 * is off. A shared, control-plane-backed implementation replaces it to unlock
 * true statelessness — same interface, so no call site changes.
 */
export class InMemorySessionLocationRegistry implements SessionLocationRegistry {
  // Built on the generic keyed registry (location-registry.ts); this class just
  // keys by sessionId and preserves the location-shaped API its callers use.
  private readonly registry = new InMemoryLocationRegistry<SessionLocation>();

  async record(location: SessionLocation): Promise<void> {
    if (!location.sessionId) throw new Error("SessionLocation.sessionId is required");
    await this.registry.record(location.sessionId, location);
  }

  async lookup(sessionId: string): Promise<SessionLocation | undefined> {
    return this.registry.lookup(sessionId);
  }

  async forget(sessionId: string): Promise<void> {
    await this.registry.forget(sessionId);
  }

  /** Number of recorded locations (test/introspection aid). */
  get size(): number {
    return this.registry.size;
  }
}
