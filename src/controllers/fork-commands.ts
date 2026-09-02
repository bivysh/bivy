// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// The session fork/move command cluster, extracted from server.ts's RELAY_COMMANDS
// (the server.ts decomposition — same shape as controllers/session-control.ts).
// These four handlers are thin orchestration over already-extracted, tested
// modules (session/fork.ts, fork-standup.ts, fork-retire.ts, fork-dirty.ts); the
// server injects its own session lookup, runtime access, event emit, and the fork
// helpers as composition deps, so this stays free of daemon state and unit-testable.

import type { CommandEntries } from "../protocol/command-registry.js";
import type { AgentRuntime } from "../runtime/index.js";
import type { SessionRecord } from "../session/record.js";
import { buildForkBundle, type ForkBundle, type ForkPlan, type ForkRecord } from "../session/fork.js";
import { captureDirtyPatch, captureWorkspaceDirtyPatch, captureWorkspaceSnapshot } from "../session/fork-dirty.js";
import type { ForkPrereq } from "../session/fork-prereqs.js";
import type { StandUpForkOptions, StandUpForkOutcome } from "../session/fork-standup.js";
import type { ForkRetireOutcome } from "../session/fork-retire.js";

export interface ForkCommandMessage {
  kind: string;
  sessionId?: unknown;
  requestId?: unknown;
  [key: string]: unknown;
}

/** Everything the fork handlers reach into the daemon for. Kept explicit so the
 *  cluster's coupling to server.ts is visible (and injectable in tests). */
export interface ForkCommandDeps {
  /** Emit to the requesting device (server wraps `relay?.sendEvent`). */
  sendEvent(event: unknown): void;
  /** Emit to every connected device (server's `broadcast`). */
  broadcast(event: unknown): void;
  resolveSession(sessionId: unknown): SessionRecord | undefined;
  getRuntime(runtimeId: string): AgentRuntime;
  forkRecordFor(rec: SessionRecord): ForkRecord;
  forkInFlightState(rec: SessionRecord): ForkBundle["state"];
  forkDoneEvent(requestId: string | undefined, record: SessionRecord, plan: ForkPlan, missing: ForkPrereq[]): unknown;
  agentFrom(msg: Record<string, unknown>): string | undefined;
  modelFrom(msg: Record<string, unknown>): { provider: string; id: string } | undefined;
  pushModelAuthToControlPlane(): Promise<void>;
  pushForkSourceBranch(rec: SessionRecord): Promise<void>;
  forkWorkspaceMaxBytes(): number;
  standUpFork(opts: StandUpForkOptions): Promise<StandUpForkOutcome<SessionRecord>>;
  retireSource(input: { sourceSessionId: string; newSessionId: string }): Promise<ForkRetireOutcome>;
}

export function createForkCommands(deps: ForkCommandDeps): CommandEntries<ForkCommandMessage> {
  return {
    async "session.fork.retire-source"(msg) {
      // Retire a MOVE's source once its destination is confirmed (1A). Gated (won't
      // retire without newSessionId) and idempotent (safe for the client to retry),
      // so a crashed-mid-move client can't orphan the source or lose it. Emits the
      // ordinary session.deleted so every device drops the moved-away source.
      const requestId = typeof msg.requestId === "string" ? msg.requestId : undefined;
      const sourceSessionId = String(msg.sourceSessionId ?? "").trim();
      const newSessionId = String(msg.newSessionId ?? "").trim();
      try {
        const outcome = await deps.retireSource({ sourceSessionId, newSessionId });
        if (!outcome.ok) {
          deps.sendEvent({ type: "session.fork.error", requestId, sessionId: sourceSessionId || undefined, error: outcome.error });
          return;
        }
        if (outcome.retired) deps.broadcast({ type: "session.deleted", sessionId: sourceSessionId });
        deps.sendEvent({ type: "session.fork.retired", requestId, sourceSessionId, newSessionId, alreadyGone: outcome.alreadyGone });
      } catch (error) {
        deps.sendEvent({ type: "session.fork.error", requestId, sessionId: sourceSessionId || undefined, error: error instanceof Error ? error.message : String(error) });
      }
    },
    async "session.fork.export"(msg) {
      // Source side of a session fork: package the session's transcript +
      // portable metadata + any uncommitted worktree changes into an E2E
      // bundle the client carries to the destination node.
      const requestId = typeof msg.requestId === "string" ? msg.requestId : undefined;
      const rec = deps.resolveSession(msg.sessionId);
      if (!rec) {
        deps.sendEvent({ type: "session.fork.error", requestId, error: "Session not found on this node." });
        return;
      }
      try {
        const forkRecord = deps.forkRecordFor(rec);
        // A git workspace must be captured successfully, including sessions that
        // were started in an unmanaged checkout rather than a Bivy worktree.
        // Treating a git/read failure as "clean" could retire the only WIP copy.
        const sourceCwd = rec.session.cwd || rec.workspace;
        const dirtyPatch = rec.worktree
          ? captureDirtyPatch(rec.worktree.path)
          : captureWorkspaceDirtyPatch(sourceCwd);
        // Plain workspaces have no remote clone source, so carry their files in
        // the E2E bundle instead of silently substituting the destination cwd.
        const workspaceSnapshot = !forkRecord.repoSlug && (msg.crossNode === true || dirtyPatch === undefined)
          ? captureWorkspaceSnapshot(sourceCwd, { maxBytes: deps.forkWorkspaceMaxBytes() })
          : undefined;
        // Publish the source branch so a cross-node fork's COMMITTED work travels
        // via origin (the destination adopts `origin/<branch>`; see
        // resolveAdoptBaseRef). Uncommitted work rides the dirtyPatch above. Only
        // for a genuine cross-node fork — a same-node cross-agent fork adopts the
        // LOCAL branch and needs no push. Best-effort: a no-token/offline node just
        // falls back to the default base downstream.
        if (msg.crossNode === true) await deps.pushForkSourceBranch(rec);
        // Refresh the account model-auth vault so the destination node can pull
        // this session's model credentials during import (fork credential-move).
        // Best-effort: local-only nodes just skip it.
        await deps.pushModelAuthToControlPlane().catch(() => {});
        // When the client has already picked a target agent, pass it so the
        // bundle omits the native payload for a cross-runtime fork (it could
        // never be replayed there — see buildForkBundle). Unset => keep it.
        const bundle = buildForkBundle({ runtime: deps.getRuntime(rec.runtimeId), sessionFile: rec.sessionFile, record: forkRecord, dirtyPatch, workspaceSnapshot, targetRuntimeId: deps.agentFrom(msg), liveMessages: rec.session.getMessages(), state: deps.forkInFlightState(rec) });
        deps.sendEvent({ type: "session.fork.bundle", requestId, bundle });
      } catch (error) {
        deps.sendEvent({ type: "session.fork.error", requestId, error: error instanceof Error ? error.message : String(error) });
      }
    },
    async "session.fork.import"(msg) {
      // Destination side of a fork: rebuild the repo/worktree, materialise the
      // transcript into the (possibly different) target runtime — full fidelity
      // for a same-runtime fork, a seeded continuation prompt otherwise — and
      // stand up the new session. The client retires the source (for a "move")
      // only after this succeeds, so a failed fork never loses the session.
      const requestId = typeof msg.requestId === "string" ? msg.requestId : undefined;
      const bundle = msg.bundle as ForkBundle | undefined;
      if (!bundle?.record || !bundle.normalized) {
        deps.sendEvent({ type: "session.fork.error", requestId, error: "Malformed fork bundle." });
        return;
      }
      try {
        // Cross-node fork: adopt the source's branch on this node and run full
        // prerequisite detection. See standUpFork / fork-prereqs.ts.
        const outcome = await deps.standUpFork({
          bundle,
          targetRuntimeId: deps.agentFrom(msg) ?? bundle.record.runtimeId,
          model: deps.modelFrom(msg),
          transcriptUrl: typeof msg.transcriptUrl === "string" ? msg.transcriptUrl : undefined,
          // Cross-agent forks can use this import handler without changing
          // nodes. In that case the source branch is already checked out here,
          // so cut an independent fork branch instead of trying to adopt it.
          worktree: msg.sameNode === true ? "fresh" : "adopt",
          detectPrereqs: true,
          // A same-node cross-agent fork can safely retain a non-repo workspace.
          // A cross-node path belongs to the source machine, so standUpFork keeps
          // its destination default unless repo metadata lets it reconstruct one.
          ...(msg.sameNode === true
            ? { fallback: { workspace: bundle.record.workspace, cwd: bundle.record.cwd } }
            : {}),
        });
        if (!outcome.ok) {
          deps.sendEvent({ type: "session.fork.error", requestId, error: outcome.error, missing: outcome.missing });
          return;
        }
        deps.sendEvent(deps.forkDoneEvent(requestId, outcome.record, outcome.plan, outcome.missing));
      } catch (error) {
        deps.sendEvent({ type: "session.fork.error", requestId, error: error instanceof Error ? error.message : String(error) });
      }
    },
    async "session.fork.local"(msg) {
      // Fast path: fork a session on the SAME node and SAME runtime WITHOUT
      // round-tripping the transcript out to the client and back. We build the
      // fork bundle in-process and stand the new session
      // up locally (via the shared standUpFork), so a large transcript never
      // leaves the node. Full fidelity by construction (same runtime → native
      // replay). The client uses this whenever the fork keeps the node and agent
      // (model may still change); any node/agent change goes through import above.
      const requestId = typeof msg.requestId === "string" ? msg.requestId : undefined;
      const rec = deps.resolveSession(msg.sessionId);
      if (!rec) {
        deps.sendEvent({ type: "session.fork.error", requestId, error: "Session not found on this node." });
        return;
      }
      try {
        const runtime = deps.getRuntime(rec.runtimeId);
        const forkRecord = deps.forkRecordFor(rec);
        // Carry uncommitted work: capture from the SOURCE worktree; standUpFork
        // re-applies it into the fork's fresh worktree. Local git ops only.
        // Include unmanaged git workspaces too. standUpFork will cut an isolated
        // worktree for them, so their uncommitted state must ride with it.
        const sourceCwd = rec.session.cwd || rec.workspace;
        const dirtyPatch = rec.worktree
          ? captureDirtyPatch(rec.worktree.path)
          : captureWorkspaceDirtyPatch(sourceCwd);
        const workspaceSnapshot = dirtyPatch === undefined
          ? captureWorkspaceSnapshot(sourceCwd, { maxBytes: deps.forkWorkspaceMaxBytes() })
          : undefined;
        // Same runtime → the bundle carries the native payload → full fidelity.
        const bundle = buildForkBundle({ runtime, sessionFile: rec.sessionFile, record: forkRecord, dirtyPatch, workspaceSnapshot, targetRuntimeId: rec.runtimeId, liveMessages: rec.session.getMessages(), state: deps.forkInFlightState(rec) });
        // Cut a fresh fork branch (the source still holds its own); skip prereq
        // detection (same node + same runtime ⇒ agent and repo are present).
        const outcome = await deps.standUpFork({
          bundle,
          targetRuntimeId: rec.runtimeId,
          model: deps.modelFrom(msg),
          worktree: "fresh",
          detectPrereqs: false,
          fallback: { workspace: rec.workspace, cwd: rec.session.cwd || rec.worktree?.path || rec.workspace },
        });
        if (!outcome.ok) {
          deps.sendEvent({ type: "session.fork.error", requestId, error: outcome.error, missing: outcome.missing });
          return;
        }
        deps.sendEvent(deps.forkDoneEvent(requestId, outcome.record, outcome.plan, outcome.missing));
      } catch (error) {
        deps.sendEvent({ type: "session.fork.error", requestId, error: error instanceof Error ? error.message : String(error) });
      }
    },
  };
}
