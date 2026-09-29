// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

/**
 * A delegated child Run as its parent session shows it (docs/agent-delegation.md):
 * one card per child, updated in place as it runs, grouped with its siblings when
 * the task was fanned out to several agents. Mirrored in packages/core/src/
 * delegations.ts; the block string MUST match there.
 */
export interface DelegationCard {
  /** The child Run id. */
  id: string;
  status: string;
  /** First line of the task, bounded. */
  task: string;
  agent?: string;
  /** Machine name the child runs on. */
  machine?: string;
  /** That machine's node id, for opening the child session. */
  nodeId?: string;
  /** Fan-out group: cards sharing it render as one comparison. */
  group?: string;
  childSessionId?: string;
  answer?: string;
  branch?: string;
  prUrl?: string;
  failure?: string;
}

export const DELEGATION_BLOCK = "bivy_delegation";
export const MAX_DELEGATION_TASK = 200;
export const MAX_DELEGATION_ANSWER = 8000;
export const TERMINAL_DELEGATION = new Set(["succeeded", "failed", "cancelled"]);

const optionalString = (v: unknown) => v === undefined || typeof v === "string";

export function isDelegationCard(value: unknown): value is DelegationCard {
  if (!value || typeof value !== "object") return false;
  const d = value as Partial<DelegationCard>;
  return typeof d.id === "string" && d.id.length > 0 && typeof d.status === "string" && typeof d.task === "string"
    && [d.agent, d.machine, d.nodeId, d.group, d.childSessionId, d.answer, d.branch, d.prUrl, d.failure].every(optionalString);
}

/** Where a delegated child session came from, stored on the child. */
export interface DelegatedFrom {
  sessionId: string;
  nodeId?: string;
  machine?: string;
  title?: string;
}

export function isDelegatedFrom(value: unknown): value is DelegatedFrom {
  if (!value || typeof value !== "object") return false;
  const d = value as Partial<DelegatedFrom>;
  return typeof d.sessionId === "string" && d.sessionId.length > 0 && d.sessionId.length <= 256
    && [d.nodeId, d.machine, d.title].every((v) => v === undefined || (typeof v === "string" && v.length <= 256));
}
