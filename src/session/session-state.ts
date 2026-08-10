// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

/** Whether this node currently has a path over which clients can reach it. */
export type SessionTransportState = "reachable" | "unreachable";
/** State of the runtime's child process, when the runtime exposes one. */
export type SessionProcessState = "alive" | "exited" | "none";
/** Runtime-neutral state of the agent turn. */
export type SessionAgentState = "idle" | "working" | "awaiting-input";
/** State of the workspace/checkpoint boundary. */
export type SessionWorkspaceState = "clean" | "dirty" | "checkpointing";
export type SessionDisplayStatus = "idle" | "working" | "needs_attention" | "failed";

/**
 * The four independent facts that make up a live session's state. `displayStatus`
 * is included as the canonical, backwards-compatible projection for consumers
 * that still need one dot/label.
 */
export interface SessionState {
  transport: SessionTransportState;
  process: SessionProcessState;
  agent: SessionAgentState;
  workspace: SessionWorkspaceState;
  displayStatus: SessionDisplayStatus;
}

export interface SessionStateEvidence {
  transportReachable: boolean;
  /** A PID was exposed and its liveness probe succeeded/failed. Undefined means
   * the runtime has no independently observable child process. */
  processAlive?: boolean;
  working: boolean;
  awaitingInput: boolean;
  workspace: SessionWorkspaceState;
  lastTurnFailed?: boolean;
}

/**
 * Pure session-state derivation. Keep precedence here rather than scattered
 * through payload builders: waiting for a human is actionable even though the
 * turn remains open; a known-dead child must never render as "working"; and a
 * historical failure is cleared by a genuinely new working turn.
 */
export function deriveSessionState(evidence: SessionStateEvidence): SessionState {
  const process: SessionProcessState = evidence.processAlive === true
    ? "alive"
    : evidence.processAlive === false
      ? "exited"
      : "none";
  const agent: SessionAgentState = evidence.awaitingInput
    ? "awaiting-input"
    : evidence.working
      ? "working"
      : "idle";

  let displayStatus: SessionDisplayStatus;
  if (agent === "awaiting-input") displayStatus = "needs_attention";
  else if (process === "exited") displayStatus = "failed";
  else if (agent === "working") displayStatus = "working";
  else if (evidence.lastTurnFailed) displayStatus = "failed";
  else displayStatus = "idle";

  return {
    transport: evidence.transportReachable ? "reachable" : "unreachable",
    process,
    agent,
    workspace: evidence.workspace,
    displayStatus,
  };
}
