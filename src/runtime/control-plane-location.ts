// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

/**
 * Control-plane-backed session-location registry — the piece that makes re-attach
 * survive a DAEMON RESTART, not just an in-daemon eviction (Stage 3 of
 * docs/agent-node-decoupling.md).
 *
 * Stage 2's `InMemorySessionLocationRegistry` is lost when the daemon dies, so a
 * restarted (or replacement) daemon has no idea which of its sessions are still
 * running on an agent service. The address, however, is already durable: the node
 * advertises it into the control plane's `session_index`
 * (`agent_service_address`), and the node-facing `GET /node/sessions` endpoint
 * returns this node's own rows WITH that address (unlike the client `/sessions`,
 * which strips it). This registry reads that endpoint so a cold daemon can resolve
 * — and adopt — its still-live sessions.
 *
 * Ownership of WRITES stays with `advertiseSessions` (the replace-all-per-node
 * POST is the single writer of `session_index`), so `record`/`forget` here are
 * deliberate no-ops: this is a read-through view of durable routing state, layered
 * UNDER the in-memory registry (in-memory first, control plane on a miss). It is
 * kept dependency-free — the HTTP fetch and the runtime-id resolver are injected —
 * so it unit-tests against fakes, mirroring backpressure.ts / location-registry.ts.
 */

import type { SessionLocation, SessionLocationRegistry } from "./session-location.js";

/** One node-owned `session_index` row as returned by `GET /node/sessions`. */
export interface NodeSessionRow {
  sessionId: string;
  agentServiceAddress?: string;
  status?: string;
  source?: string;
  branch?: string;
}

export interface ControlPlaneLocationOptions {
  /**
   * Fetch this node's own session-index rows from the control plane
   * (`GET /node/sessions`). Injected so the registry stays transport-free and
   * testable; returns `[]` (never throws to the caller) when the control plane is
   * unreachable so a lookup degrades to "unknown" rather than an error.
   */
  fetchNodeSessions: () => Promise<NodeSessionRow[]>;
  /**
   * Resolve the runtime id for a session from durable node-local state (the
   * on-disk metadata store survives a restart). The control plane does not store
   * the runtime id — it is node-local — but re-attach needs it to build the right
   * RemoteRuntime, so a row whose runtime id can't be resolved is not adoptable.
   */
  resolveRuntimeId: (sessionId: string) => string | undefined;
  /** Owning node id, stamped onto returned locations. Optional. */
  nodeId?: string;
}

export class ControlPlaneSessionLocationRegistry implements SessionLocationRegistry {
  constructor(private readonly options: ControlPlaneLocationOptions) {}

  /** Map a durable row to a routable location, or undefined if not adoptable. */
  private toLocation(row: NodeSessionRow): SessionLocation | undefined {
    if (!row.sessionId || !row.agentServiceAddress) return undefined;
    const runtimeId = this.options.resolveRuntimeId(row.sessionId);
    if (!runtimeId) return undefined; // can't route an attach without the runtime id
    return { sessionId: row.sessionId, agentServiceAddress: row.agentServiceAddress, runtimeId, nodeId: this.options.nodeId };
  }

  async lookup(sessionId: string): Promise<SessionLocation | undefined> {
    if (!sessionId) return undefined;
    const rows = await this.options.fetchNodeSessions().catch(() => [] as NodeSessionRow[]);
    const row = rows.find((r) => r.sessionId === sessionId);
    return row ? this.toLocation(row) : undefined;
  }

  /**
   * Every adoptable session this node currently owns in the control plane (has a
   * host address AND a resolvable runtime id). Startup adoption iterates this and
   * re-attaches to each. Never throws — a fetch failure yields `[]`.
   */
  async listNode(): Promise<SessionLocation[]> {
    const rows = await this.options.fetchNodeSessions().catch(() => [] as NodeSessionRow[]);
    const out: SessionLocation[] = [];
    for (const row of rows) {
      const location = this.toLocation(row);
      if (location) out.push(location);
    }
    return out;
  }

  // Writes are owned by advertiseSessions (the replace-all POST to /node/sessions
  // is the single writer of session_index); this is a read-through view.
  async record(_location: SessionLocation): Promise<void> {
    /* no-op: advertise owns control-plane writes */
  }

  async forget(_sessionId: string): Promise<void> {
    /* no-op: advertise owns control-plane writes */
  }
}

/**
 * Layers two registries so a lookup prefers the fast, authoritative in-memory
 * entry (this daemon's own live sessions) and falls through to a shared,
 * durable one (the control plane) only on a miss — exactly the "in-memory first,
 * then control-plane" ordering Stage 3 needs so nothing regresses when the
 * process already knows a session. Writes (`record`/`forget`) go to the primary
 * (in-memory) layer; the control-plane layer's writes are no-ops by design.
 */
export class LayeredSessionLocationRegistry implements SessionLocationRegistry {
  constructor(
    private readonly primary: SessionLocationRegistry,
    private readonly fallback: SessionLocationRegistry,
  ) {}

  async record(location: SessionLocation): Promise<void> {
    await this.primary.record(location);
    await this.fallback.record(location);
  }

  async lookup(sessionId: string): Promise<SessionLocation | undefined> {
    return (await this.primary.lookup(sessionId)) ?? (await this.fallback.lookup(sessionId));
  }

  async forget(sessionId: string): Promise<void> {
    await this.primary.forget(sessionId);
    await this.fallback.forget(sessionId);
  }
}
