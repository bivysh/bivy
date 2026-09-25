// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Resolving the Session a durable Run targets. A Run aimed at an existing
// Session (or any scheduled Run) is strict: it continues that Session, resumed
// from disk or a snapshot if needed, or fails visibly. It never silently cold-
// starts a new Session without the context the user pointed it at.

export interface SessionTargetItem {
  source?: string;
  targetKind?: string;
  targetSessionId?: string;
}

/** Scheduled Runs and Runs aimed at an existing Session must land in that Session. */
export function requiresExistingSession(item: SessionTargetItem): boolean {
  return item.source === "schedule" || item.targetKind === "existing_session";
}

export interface SessionTargetResolvers<R> {
  /** A Session already open on this Machine. */
  open(id: string): R | undefined;
  /** Reopen a closed Session from its durable metadata and transcript. */
  resume(id: string): Promise<R | undefined>;
  /** Restore a Session's snapshot onto this Machine; true when restored. */
  restoreSnapshot(id: string): Promise<boolean>;
}

/**
 * The targeted Session, or null when the item targets none or (non-strict) it is
 * unavailable, in which case the caller falls through to a fresh pickup. Throws
 * when a strict target cannot be continued.
 */
export async function resolveTargetSession<R>(
  item: SessionTargetItem,
  resolvers: SessionTargetResolvers<R>,
  strict: boolean,
): Promise<R | null> {
  if (item.targetKind !== "existing_session" || !item.targetSessionId) return null;
  const id = item.targetSessionId;
  let record = resolvers.open(id);
  if (!record && strict) record = await resolvers.resume(id).catch(() => undefined);
  if (!record && await resolvers.restoreSnapshot(id)) record = await resolvers.resume(id).catch(() => undefined);
  if (record) return record;
  if (strict) throw new Error(`This Run could not continue session ${id}: the session is not available on this Machine`);
  return null;
}
