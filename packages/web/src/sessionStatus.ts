// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import type { SessionStatus } from "@bivy/core";

/** The subset of SessionSummary that status/seen derivation needs — kept
 *  narrow so callers (sidebar rows, the header pill) can pass either the full
 *  row or a partial/synthetic one without extra plumbing. */
export interface SessionStatusInput {
  status?: SessionStatus;
  needsAction?: boolean;
  lastSeenAt?: number;
  finishedAt?: number;
}

/** Dot shape/base-color class. Shape carries the live/not-live signal (filled
 *  vs. hollow ring — see .session-dot.saved in styles.css) so that axis never
 *  depends on color alone; the color itself distinguishes needs-action /
 *  working / idle. Shared by the sidebar row and the header status pill so
 *  the two views can never drift out of sync. */
export function statusClass(s: SessionStatusInput): string {
  if (s.needsAction || s.status === "needs_action") return "needs-action";
  if (s.status === "working") return "working";
  if (s.status === "saved") return "saved";
  return "idle";
}

/** True once an agent run has *actually* finished (the agent_end transition
 *  to "idle" — see finishedAt's doc in packages/core/src/store.ts) and that
 *  finish is more recent than the last time the user had this session open.
 *  Deliberately narrower than "status === idle": a brand-new session or a
 *  cold sessions.list snapshot never carries `finishedAt`, so neither ever
 *  reads as an unseen finished run. */
export function isUnseen(s: SessionStatusInput): boolean {
  if (s.status !== "idle" || s.finishedAt == null) return false;
  return s.lastSeenAt == null || s.finishedAt > s.lastSeenAt;
}

/** Human-facing status text — the accessible (non-color) half of the signal,
 *  read by the dot's title/tooltip and screen readers. */
export function statusLabel(s: SessionStatusInput): string {
  if (s.needsAction || s.status === "needs_action") return "Needs your response";
  if (s.status === "working") return "Agent working";
  // "saved" means the node has no live record for this session (closed, not
  // attached) — distinct from "idle", where it's open on the node and can be
  // resumed instantly. Both used to render as the same flat grey dot.
  if (s.status === "saved") return "Saved · not open on node";
  return isUnseen(s) ? "Finished · new" : "Open on node";
}
