// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Daemon integration for warm session replication (docs/session-replication.md):
// assembles the unit-tested owner/standby orchestration (replicator.ts), the git
// checkpoint bundle (checkpoint-pack.ts), the sibling relay-client transport
// (sibling-client.ts), and the control-plane ownership endpoints into one service
// the node daemon drives through a handful of thin adapters (server.ts owns the
// daemon-specific accessors, so THIS module has no server.ts coupling).
//
// Owner: on each turn boundary, `onTurnComplete(sessionId)` declares the standby
// (once), gets the supervised standby connection (which reconnects on its own with
// backoff — reconnect.ts), ships a frame, and advances the cursor on ack (retrying
// once on a full-resync request). Standby: `handleReplicaFrame` applies an inbound
// frame; `promote` runs the control-plane compare-and-set and materializes the
// replica for local resume.
//
// Gated entirely on the node's sessionSync setting + a chosen standby, both off by
// default — so when replication is disabled this service is inert and the daemon
// behaves exactly as before.

import { OwnerReplicator, StandbyApplier, type ReplWireFrame, type ReplAck } from "./replicator.js";
import { createCheckpointBundle, applyCheckpointBundle, materializeCheckpoint } from "./checkpoint-pack.js";
import { SiblingClient } from "./sibling-client.js";
import { ReconnectingConnection } from "./reconnect.js";
import type { LogRecord } from "./event-log.js";

export interface ReplicationSettings {
  sessionSync: boolean;
  worktreeSync: boolean;
  standbyNodeId?: string;
}

export interface ReplicationServiceDeps {
  controlPlaneUrl: () => string | undefined;
  enrollmentToken: () => string | undefined;
  relayUrl: () => string | undefined;
  settings: () => ReplicationSettings;

  // --- owner sources -------------------------------------------------------
  /** The session's full ordered transcript records (EventLog.entries). */
  readRecords: (sessionId: string) => LogRecord[];
  /** The session's current checkpoint sha, or undefined for a non-git workspace. */
  checkpointHead: (sessionId: string) => Promise<string | undefined>;
  /** A path inside the session's owner repo (for bundling), or undefined. */
  repoDirFor: (sessionId: string) => string | undefined;
  /** The runtime's opaque resume token (record.sessionFile). */
  runtimeSessionRef: (sessionId: string) => string | undefined;

  // --- standby sinks -------------------------------------------------------
  /** Ensure a replica worktree exists for the session and return its path. */
  replicaRepoDir: (sessionId: string) => Promise<string | undefined>;
  /** Persist the replica transcript authoritatively (EventLog.rewrite). */
  persistReplicaRecords: (sessionId: string, records: LogRecord[]) => void;
  /** Record/refresh replica session metadata so it lists as a standby copy. */
  upsertReplicaMeta: (sessionId: string, info: { runtimeSessionRef?: string; ownerNodeId?: string }) => void;

  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
}

export class ReplicationService {
  private owner: OwnerReplicator;
  private standby: StandbyApplier;
  // A single supervised connection to the current standby: it reconnects with
  // backoff on drop, so replication survives relay blips / standby restarts
  // instead of silently pausing until the next turn (follow-up #2).
  private supervisor?: ReconnectingConnection<SiblingClient>;
  private supervisorStandbyId?: string;
  private declared = new Set<string>();
  private epochs = new Map<string, number>();

  constructor(private readonly deps: ReplicationServiceDeps) {
    this.owner = new OwnerReplicator({
      readRecords: (id) => deps.readRecords(id),
      epochOf: (id) => this.epochs.get(id) ?? 0,
      checkpointHead: (id) => deps.checkpointHead(id),
      bundleCheckpoint: async (id, since) => {
        const dir = deps.repoDirFor(id);
        return dir ? createCheckpointBundle(dir, id, since) : null;
      },
      runtimeSessionRef: (id) => deps.runtimeSessionRef(id),
      worktreeSync: () => deps.settings().worktreeSync === true,
    });
    this.standby = new StandbyApplier({
      persistRecords: (id, records) => deps.persistReplicaRecords(id, records),
      applyBundle: async (id, bundle) => {
        const dir = await deps.replicaRepoDir(id);
        if (!dir) return { ok: false, needFull: true };
        return applyCheckpointBundle(dir, id, bundle);
      },
      materialize: async (id) => {
        const dir = await deps.replicaRepoDir(id);
        if (dir) await materializeCheckpoint(dir, id);
      },
    });
  }

  private get fetchImpl(): typeof fetch {
    return this.deps.fetchImpl ?? fetch;
  }

  private ready(): { cp: string; token: string; standbyId: string } | null {
    const s = this.deps.settings();
    if (!s.sessionSync || !s.standbyNodeId) return null;
    const cp = this.deps.controlPlaneUrl();
    const token = this.deps.enrollmentToken();
    if (!cp || !token) return null;
    return { cp: cp.replace(/\/$/, ""), token, standbyId: s.standbyNodeId };
  }

  private async cpPost(path: string, token: string, body: unknown): Promise<Record<string, unknown> | undefined> {
    try {
      const res = await this.fetchImpl(`${this.deps.controlPlaneUrl()!.replace(/\/$/, "")}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (!res.ok) return undefined;
      return (await res.json()) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }

  private async cpGet(path: string, token: string): Promise<Record<string, unknown> | undefined> {
    try {
      const res = await this.fetchImpl(`${this.deps.controlPlaneUrl()!.replace(/\/$/, "")}${path}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) return undefined;
      return (await res.json()) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }

  /** Time a turn will wait for the standby connection before skipping this round. */
  private static readonly ENSURE_TIMEOUT_MS = 10_000;

  /**
   * The supervised connection to `standbyId`, created (and started) on demand and
   * kept alive across turns. Switching standby tears the old one down. The
   * supervisor owns reconnection: each attempt mints fresh credentials + a fresh
   * `SiblingClient` and wires its close back to the supervisor's drop signal.
   */
  private supervisorFor(standbyId: string): ReconnectingConnection<SiblingClient> {
    if (this.supervisor && this.supervisorStandbyId === standbyId) return this.supervisor;
    this.supervisor?.stop();
    const sup = new ReconnectingConnection<SiblingClient>({
      connect: async (onDrop) => {
        const cp = this.deps.controlPlaneUrl();
        const token = this.deps.enrollmentToken();
        if (!cp || !token) throw new Error("control plane not configured");
        const client = new SiblingClient({
          controlPlaneUrl: cp,
          enrollmentToken: token,
          siblingNodeId: standbyId,
          relayUrl: this.deps.relayUrl(),
          label: "Bivy replica",
          fetchImpl: this.deps.fetchImpl,
          onClose: () => onDrop(),
        });
        await client.connect();
        return client;
      },
      close: (client) => client.close(),
      onActive: () => this.deps.log?.(`replication: connected to standby ${standbyId}`),
      onDrop: () => this.deps.log?.(`replication: standby ${standbyId} connection dropped; reconnecting`),
      onRetry: (err, ms) =>
        this.deps.log?.(`replication: standby ${standbyId} unreachable (${(err as Error)?.message ?? err}); retrying in ${ms}ms`),
      backoff: { baseMs: 1000, factor: 2, maxMs: 30_000, jitter: 0.3 },
    });
    this.supervisor = sup;
    this.supervisorStandbyId = standbyId;
    sup.start();
    return sup;
  }

  /** Tear down the standby connection (sync disabled, or shutting down). */
  private stopSupervisor(): void {
    this.supervisor?.stop();
    this.supervisor = undefined;
    this.supervisorStandbyId = undefined;
  }

  /** OWNER: called after a turn completes for a session. Ships one frame. */
  async onTurnComplete(sessionId: string): Promise<void> {
    const r = this.ready();
    if (!r) {
      // Sync turned off (or standby cleared) → drop the connection.
      this.stopSupervisor();
      return;
    }
    // Declare the standby + learn our epoch once per session.
    if (!this.declared.has(sessionId)) {
      const res = await this.cpPost(`/node/sessions/${encodeURIComponent(sessionId)}/standby`, r.token, { standbyNodeId: r.standbyId });
      const ownership = res?.ownership as { ownerEpoch?: number } | undefined;
      if (ownership && typeof ownership.ownerEpoch === "number") this.epochs.set(sessionId, ownership.ownerEpoch);
      this.declared.add(sessionId);
    }
    // Wait briefly for the (supervised, self-reconnecting) standby connection. If
    // it isn't up yet, skip this round — the replicator is log-based, so the next
    // successful turn ships the accumulated delta.
    const client = await this.supervisorFor(r.standbyId).ensure(ReplicationService.ENSURE_TIMEOUT_MS);
    if (!client) return;
    await this.shipOnce(sessionId, client, true);
  }

  private async shipOnce(sessionId: string, client: SiblingClient, allowRetry: boolean): Promise<void> {
    const frame = await this.owner.buildTurnFrame(sessionId);
    if (!frame) return;
    try {
      const reply = await client.request({ kind: "session.replica.frame", frame });
      const ack = (reply.ack ?? reply) as ReplAck;
      const resend = this.owner.applyAck(sessionId, ack);
      if (resend && allowRetry) await this.shipOnce(sessionId, client, false);
    } catch (err) {
      this.deps.log?.(`replication: ship failed for ${sessionId}: ${(err as Error).message}`);
    }
  }

  /** STANDBY: apply an inbound replication frame and return the ack. */
  async handleReplicaFrame(frame: ReplWireFrame, ownerNodeId?: string): Promise<ReplAck> {
    const ack = await this.standby.receive(frame);
    if (ack.status === "applied") {
      this.deps.upsertReplicaMeta(frame.sessionId, { runtimeSessionRef: frame.runtimeSessionRef, ownerNodeId });
    }
    return ack;
  }

  /**
   * STANDBY: promote this node to owner of a replicated session. Reads the current
   * epoch, runs the control-plane compare-and-set, and (on success) materializes
   * the replica working tree so the session can resume locally. Returns the new
   * owner epoch, or undefined if the promotion lost the race.
   */
  async promote(sessionId: string, thisNodeId: string): Promise<number | undefined> {
    const cp = this.deps.controlPlaneUrl();
    const token = this.deps.enrollmentToken();
    if (!cp || !token) return undefined;
    const owned = await this.cpGet(`/node/sessions/${encodeURIComponent(sessionId)}/ownership`, token);
    const ownership = owned?.ownership as { ownerEpoch?: number } | null | undefined;
    const expectedEpoch = ownership && typeof ownership.ownerEpoch === "number" ? ownership.ownerEpoch : 0;
    const res = await this.cpPost(`/node/sessions/${encodeURIComponent(sessionId)}/promote`, token, {
      toNodeId: thisNodeId,
      expectedEpoch,
    });
    const promoted = res?.ownership as { ownerEpoch?: number } | undefined;
    if (!promoted) return undefined;
    const dir = await this.deps.replicaRepoDir(sessionId);
    if (dir) await materializeCheckpoint(dir, sessionId).catch(() => {});
    this.standby.forget(sessionId);
    return promoted.ownerEpoch;
  }

  /** Tear down (session closed / node shutdown). */
  forget(sessionId: string): void {
    this.owner.forget(sessionId);
    this.standby.forget(sessionId);
    this.declared.delete(sessionId);
    this.epochs.delete(sessionId);
  }

  close(): void {
    this.stopSupervisor();
  }
}
