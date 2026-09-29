// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

/** A delegated child Run as its parent session shows it. Mirrors
 *  src/session/delegations.ts; the block string MUST match there. */
export interface DelegationCard {
  id: string;
  status: string;
  task: string;
  agent?: string;
  machine?: string;
  nodeId?: string;
  group?: string;
  childSessionId?: string;
  answer?: string;
  branch?: string;
  prUrl?: string;
  failure?: string;
}

export const DELEGATION_BLOCK = "bivy_delegation";
export const TERMINAL_DELEGATION = new Set(["succeeded", "failed", "cancelled"]);

export function isDelegationCard(value: unknown): value is DelegationCard {
  if (!value || typeof value !== "object") return false;
  const d = value as Partial<DelegationCard>;
  const optional = (v: unknown) => v === undefined || typeof v === "string";
  return typeof d.id === "string" && d.id.length > 0 && typeof d.status === "string" && typeof d.task === "string"
    && [d.agent, d.machine, d.nodeId, d.group, d.childSessionId, d.answer, d.branch, d.prUrl, d.failure].every(optional);
}

/** Where a delegated child session came from (shown on the child). */
export interface DelegatedFrom {
  sessionId: string;
  nodeId?: string;
  machine?: string;
  title?: string;
}
