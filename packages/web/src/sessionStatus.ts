// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import type { SessionStatus } from "@bivy/core";

/** The subset of SessionSummary that status/seen derivation needs — kept
 *  narrow so callers (sidebar rows, the header pill) can pass either the full
 *  row or a partial/synthetic one without extra plumbing. */
export type SessionDotState = "idle" | "unseen" | "working" | "needs-action" | "failed" | "saved";

export interface SessionStatusInput {
  status?: SessionStatus;
  state?: { agent?: "idle" | "working" | "waiting" | "awaiting-input" };
  needsAction?: boolean;
  lastSeenAt?: number;
  finishedAt?: number;
  failedAt?: number;
}

/** Dot shape/base-color class. Shape carries the live/not-live signal (filled
 *  vs. hollow ring — see .session-dot.saved in styles.css) so that axis never
 *  depends on color alone; the color itself distinguishes needs-action /
 *  working / idle. Shared by the sidebar row and the header status pill so
 *  the two views can never drift out of sync. */
export function statusClass(s: SessionStatusInput): Exclude<SessionDotState, "unseen"> {
  if (s.needsAction || s.status === "needs_action") return "needs-action";
  if (s.status === "working") return "working";
  if (s.status === "failed") return "failed";
  if (s.status === "saved") return "saved";
  return "idle";
}

/** True once an agent run has *actually* finished (the agent_end transition
 *  to "idle" — see finishedAt's doc in packages/core/src/store.ts) and that
 *  finish is more recent than the last time the user had this session open.
 *  Deliberately narrower than "status === idle": a brand-new session or a
 *  cold sessions.list snapshot never carries `finishedAt`, so neither ever
 *  reads as an unseen finished run. */
export function statusDotState(s: SessionStatusInput): SessionDotState {
  return isUnseen(s) ? "unseen" : statusClass(s);
}

export function isUnseen(s: SessionStatusInput): boolean {
  if (s.status !== "idle" || s.finishedAt == null) return false;
  return s.lastSeenAt == null || s.finishedAt > s.lastSeenAt;
}

/** How urgently a session wants the user's eyes, for sorting the sidebar so the
 *  ones that need a human float to the top (highest first):
 *    2 — needs action (an approval or question is blocking the agent);
 *    1 — a run finished the user hasn't looked at yet;
 *    0 — the calm majority (working / idle / saved).
 *  A session's own recency (updatedAt) is the tiebreak within a rank, so within
 *  "needs action" the freshest still leads. Keeping this one function the single
 *  source of ranking means the sidebar and any future surface can't disagree
 *  about what counts as "needs you". */
export function attentionRank(s: SessionStatusInput): number {
  if (s.needsAction || s.status === "needs_action") return 3;
  if (s.status === "failed") return 2;
  if (isUnseen(s)) return 1;
  return 0;
}

/** Human-facing status text — the accessible (non-color) half of the signal,
 *  read by the dot's title/tooltip and screen readers. */
export function runStatusLabel(s: SessionStatusInput): string {
  if (s.needsAction || s.status === "needs_action") return "Waiting for you";
  if (s.status === "working") return "Working";
  if (s.status === "failed") return "Failed";
  if (s.finishedAt != null) return "Finished";
  if (s.status === "saved") return "Saved";
  return "Open";
}

export function statusLabel(s: SessionStatusInput): string {
  if (s.needsAction || s.status === "needs_action") return "Needs your response";
  if (s.state?.agent === "waiting") return "Waiting for background tasks";
  if (s.status === "working") return "Agent working";
  if (s.status === "failed") return "Last turn failed";
  // "saved" means the node has no live record for this session (closed, not
  // attached) — distinct from "idle", where it's open on the node and can be
  // resumed instantly. Both used to render as the same flat grey dot.
  if (s.status === "saved") return "Saved";
  return isUnseen(s) ? "Finished · new" : "Open";
}
