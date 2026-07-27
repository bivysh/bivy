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

/**
 * The identity key two rows share iff they're the same durable conversation: a
 * resolved on-disk path when known (so relative/absolute spellings of the same
 * file collapse together), else the bare id. Shared by dedupeSessionSummaries
 * below and by native-session-discovery.ts's cross-check against Bivy-managed
 * sessions (issue #156) — one identity scheme, not two copies of it.
 */
export function sessionIdentityKey(ref: { id?: string; path?: string }): string {
  return ref.path ? `ref:${path.resolve(ref.path)}` : `id:${ref.id}`;
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
    const identity = sessionIdentityKey(ref ? { path: ref } : { id: session.id });
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
