// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

import type { GithubQueueItem } from "./account.js";

export type RunOutcomeKind =
  | "running"
  | "waiting"
  | "pr_open"
  | "changes_ready"
  | "checks_failed"
  | "needs_review"
  | "no_changes"
  | "agent_failed"
  | "timed_out"
  | "cancelled";

export interface RunOutcome {
  kind: RunOutcomeKind;
  label: string;
  tone: "neutral" | "success" | "warning" | "danger";
  terminal: boolean;
  reviewable: boolean;
}

const OUTCOMES: Record<RunOutcomeKind, RunOutcome> = {
  running: { kind: "running", label: "Running", tone: "neutral", terminal: false, reviewable: false },
  waiting: { kind: "waiting", label: "Waiting", tone: "neutral", terminal: false, reviewable: false },
  pr_open: { kind: "pr_open", label: "PR open", tone: "success", terminal: true, reviewable: true },
  changes_ready: { kind: "changes_ready", label: "Changes ready", tone: "success", terminal: true, reviewable: true },
  checks_failed: { kind: "checks_failed", label: "Checks failed", tone: "danger", terminal: true, reviewable: true },
  needs_review: { kind: "needs_review", label: "Needs review", tone: "warning", terminal: true, reviewable: true },
  no_changes: { kind: "no_changes", label: "No changes", tone: "neutral", terminal: true, reviewable: false },
  agent_failed: { kind: "agent_failed", label: "Agent failed", tone: "danger", terminal: true, reviewable: true },
  timed_out: { kind: "timed_out", label: "Timed out", tone: "danger", terminal: true, reviewable: true },
  cancelled: { kind: "cancelled", label: "Cancelled", tone: "neutral", terminal: true, reviewable: false },
};

/** Derive customer outcome from durable evidence. Process completion alone is
 * never success: a terminal run needs an artifact, deterministic check result,
 * explicit no-change event, failure, or a needs-review fallback. */
export function deriveRunOutcome(item: Pick<GithubQueueItem, "status" | "output" | "checks" | "events">): RunOutcome {
  if (item.status === "cancelled") return OUTCOMES.cancelled;
  const failedCheck = item.checks?.some((check) => check.status === "failed");
  if (failedCheck) return OUTCOMES.checks_failed;
  const failure = item.output?.failure?.toLowerCase() ?? "";
  if (item.status === "failed") return /timed?\s*out/.test(failure) ? OUTCOMES.timed_out : OUTCOMES.agent_failed;
  if (item.status === "needs_attention") return OUTCOMES.needs_review;
  // Waiting/rate-limited is distinct from actively running (C4b): the run exists
  // but is blocked on an external limit (provider 429, queue backpressure) rather
  // than consuming compute. Representing it separately stops "stuck but fine" work
  // from looking either hung or busy.
  const runningLike = item.status === "pending" || item.status === "claimed" || item.status === "running";
  const events = item.events ?? [];
  const lastEvent = events[events.length - 1];
  if (item.status === "waiting" || (runningLike && lastEvent?.kind === "rate_limited")) return OUTCOMES.waiting;
  if (runningLike) return OUTCOMES.running;
  if (item.output?.prUrl) return OUTCOMES.pr_open;
  if (item.output?.branch || item.output?.commit || item.output?.checkpoint || item.output?.artifactUrl) return OUTCOMES.changes_ready;
  const summaries = (item.events ?? []).map((event) => event.summary.toLowerCase());
  if (summaries.some((summary) => summary.includes("no file changes") || summary.includes("no changes"))) return OUTCOMES.no_changes;
  // A completed process with no artifact/check/no-change evidence is explicitly
  // review-needed, never silently promoted to succeeded.
  return OUTCOMES.needs_review;
}
