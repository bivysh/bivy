// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import type { NodeRecord, SessionIndexEntry } from "./store.js";

/**
 * How many sessions occupy an *active* slot against the plan's session cap.
 *
 * The cross-node session index is deliberately broader than "what's running
 * now": it also carries sessions a node advertised as "saved" (closed but
 * resumable) and sessions left behind on a node that has since gone offline.
 * Both still belong in the unified session list a client renders, but neither
 * is actually open anywhere, so neither should consume an active-session slot.
 *
 * Counting them was the bug behind "session enforcement seems off": the cap
 * tripped with far fewer than N sessions genuinely open, because saved and
 * offline-node entries padded the total. This mirrors the node-side local
 * count (see createSession in src/server.ts), which counts only sessions it
 * currently holds open and excludes empty/untitled records.
 *
 * A session counts only when (a) it is advertised with a live status — anything
 * other than "saved" (i.e. idle / working / needs_action) — and (b) its owning
 * node is currently online.
 */
export function countActiveAccountSessions(sessions: SessionIndexEntry[], nodes: NodeRecord[]): number {
  const onlineNodeIds = new Set(nodes.filter((node) => node.online).map((node) => node.id));
  return sessions.filter((session) => session.status !== "saved" && onlineNodeIds.has(session.nodeId)).length;
}
