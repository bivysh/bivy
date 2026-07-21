// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import path from "node:path";
import type { SessionSummary } from "./runtime/types.js";

export type OwnedSessionSummary = SessionSummary & { agent: string; agentName: string };

export interface SessionIdentityOwner {
  id: string;
  path?: string;
  runtimeId?: string;
}

/** Collapse adapter-local rows that point at the same durable conversation. */
export function dedupeSessionSummaries(
  sessions: OwnedSessionSummary[],
  ownerFor: (session: OwnedSessionSummary) => SessionIdentityOwner | undefined,
): OwnedSessionSummary[] {
  const byIdentity = new Map<string, OwnedSessionSummary>();
  for (const session of sessions) {
    const owner = ownerFor(session);
    const ref = owner?.path || session.path;
    const identity = ref ? `ref:${path.resolve(ref)}` : `id:${session.id}`;
    const current = byIdentity.get(identity);
    if (!current) {
      byIdentity.set(identity, session);
      continue;
    }
    const score = (candidate: OwnedSessionSummary): number => {
      const candidateOwner = ownerFor(candidate);
      return Number(candidateOwner?.id === candidate.id) * 2 + Number(candidateOwner?.runtimeId === candidate.agent);
    };
    if (score(session) > score(current)) byIdentity.set(identity, session);
  }
  return [...byIdentity.values()];
}
