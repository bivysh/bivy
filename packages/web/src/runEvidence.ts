// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
//
// Join a session to the automation run that produced it, and derive the small
// display bits both the sidebar row (an exception hint) and the in-session run
// pill (the full outcome) show. The evidence lives on the account work queue
// (`GithubQueueItem`, fetched in App), never on the session summary — see
// docs/automation-runs.md. Everything here is read-only projection over that
// already-sanitized record; it never reaches for a prompt/transcript/diff.

import type { GithubQueueItem } from "@bivy/core";

/** sessionId → its run evidence. Only a claimed-or-later run carries
 *  `output.sessionId`, so pending items simply don't appear (nothing to join
 *  to yet). Hosted-only: in direct/local mode the queue is null and every
 *  lookup misses, which callers treat as "no extra detail", not an error. */
export function indexRunEvidence(queue: GithubQueueItem[] | null | undefined): Map<string, GithubQueueItem> {
  const map = new Map<string, GithubQueueItem>();
  for (const item of queue ?? []) {
    const sid = item.output?.sessionId;
    if (sid && !map.has(sid)) map.set(sid, item);
  }
  return map;
}

export interface CheckCounts {
  passed: number;
  failed: number;
  skipped: number;
  total: number;
}

/** Tallied validation checks, or null when the run declared none. */
export function checkCounts(item: GithubQueueItem): CheckCounts | null {
  const checks = item.checks;
  if (!checks || checks.length === 0) return null;
  let passed = 0, failed = 0, skipped = 0;
  for (const c of checks) {
    if (c.status === "passed") passed++;
    else if (c.status === "failed") failed++;
    else skipped++;
  }
  return { passed, failed, skipped, total: checks.length };
}

/** Compact wall-clock duration (started→completed) like "38s", "4m", "1h 3m".
 *  Null until the run has both a start and an end. */
export function runDuration(item: GithubQueueItem): string | null {
  const start = item.startedAt ?? item.claimedAt;
  const end = item.completedAt;
  if (!start || !end) return null;
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem ? `${hrs}h ${rem}m` : `${hrs}h`;
}

/** The bounded reason a retry/fallback happened, if the timeline recorded one —
 *  so "attempt 3" can read "attempt 3 · fell back after node offline". */
export function retryReason(item: GithubQueueItem): string | null {
  const ev = [...(item.events ?? [])].reverse().find((e) => e.kind === "retry" || e.kind === "fallback");
  return ev?.summary || null;
}

export interface RowHint {
  text: string;
  /** `danger` for a failed run, `warn` for one waiting on a person. */
  tone: "danger" | "warn";
}

/** The one short exception phrase a sidebar row shows so failures and
 *  waiting-on-you runs pop in a long list — null for the calm majority
 *  (succeeded / running / plain sessions), which need no extra words. */
export function rowHint(item: GithubQueueItem | undefined): RowHint | null {
  if (!item) return null;
  if (item.status === "failed") {
    const failed = (item.checks ?? []).find((c) => c.status === "failed");
    if (failed) return { text: `${failed.name} failed`, tone: "danger" };
    return { text: item.output?.failure || "run failed", tone: "danger" };
  }
  if (item.status === "needs_attention") {
    const ev = [...(item.events ?? [])].reverse().find(
      (e) => e.kind === "needs_attention" || e.kind === "approval" || e.kind === "policy_denial",
    );
    return { text: ev?.summary || item.routingReason || "needs your input", tone: "warn" };
  }
  return null;
}
