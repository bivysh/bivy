// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Session limit recovery — the user-driven counterpart to the policy's automatic
// resume (session-reroute.ts planResume).
//
// When a turn ends because the agent hit a provider usage/rate limit and no
// ruleset recovered it automatically, the session shouldn't just show a dead
// error. This decides whether the failure IS such a limit, and what the user can
// do about it: fork the work to another agent right away, or opt in to retrying
// the same prompt automatically once the window resets. The caller (server.ts)
// surfaces the offer as a notice with action buttons and, when the user accepts
// the retry, schedules it through the same durable resume machinery the
// automatic path uses.

import { classifyFailure, type RuntimeCondition } from "./conditions.js";
import type { ResumePlan } from "./session-reroute.js";

/** A limit the session's last turn hit, remembered until the next user turn. */
export interface SessionLimit {
  condition: RuntimeCondition;
  /** ISO instant the window resets, when the provider told us. */
  resetsAt?: string;
}

/** The conditions a user can route around (fork) or wait out (retry at reset),
 *  with how the notice describes each. Adding a limit-like condition is a row. */
const LIMIT_COPY: Partial<Record<RuntimeCondition, string>> = {
  credits_exhausted: "reached its usage limit",
  rate_limited: "is being rate-limited",
};

/** Retry a little after the stated reset: providers round reset times and a
 *  re-send that lands a few seconds early just hits the same limit again. */
const RESET_GRACE_MS = 60_000;

/** Classify a turn error; returns the limit it represents, or undefined when it
 *  is some other failure. `resetsAtHint` is the provider's structured reset time
 *  (see ClassifyOptions) and wins over anything scraped from the text. */
export function detectSessionLimit(
  error: unknown,
  opts: { now?: number; resetsAtHint?: string } = {},
): SessionLimit | undefined {
  const now = opts.now ?? Date.now();
  const classified = classifyFailure(error, { now, resetsAtHint: opts.resetsAtHint });
  if (!LIMIT_COPY[classified.condition]) return undefined;
  const resetsAt = classified.resetsAt
    ?? (classified.retryAfterMs !== undefined ? new Date(now + classified.retryAfterMs).toISOString() : undefined);
  return { condition: classified.condition, ...(resetsAt ? { resetsAt } : {}) };
}

/** The notice offering the user a way past the limit. Actions are client
 *  action ids: `fork` opens the fork sheet; `retry-at-reset:<iso>` opts in to an
 *  automatic retry (the timestamp is only for the button's label — the daemon
 *  schedules from its own remembered limit). */
export function sessionLimitNotice(agentName: string, limit: SessionLimit): { message: string; actions: string[] } {
  const what = `${agentName} ${LIMIT_COPY[limit.condition] ?? "hit a limit"}.`;
  return limit.resetsAt
    ? {
      message: `${what} Fork to another agent to keep going, or retry automatically when the limit resets.`,
      actions: ["fork", `retry-at-reset:${limit.resetsAt}`],
    }
    : { message: `${what} Fork to another agent to keep going.`, actions: ["fork"] };
}

/** A resume plan for a user who opted in to retrying at reset. Undefined when
 *  the reset time is unknown. A reset already in the past retries shortly. */
export function limitResumePlan(limit: SessionLimit, now = Date.now()): ResumePlan | undefined {
  const reset = limit.resetsAt ? Date.parse(limit.resetsAt) : NaN;
  if (!Number.isFinite(reset)) return undefined;
  const dueMs = Math.max(reset, now) + RESET_GRACE_MS;
  return {
    condition: limit.condition,
    summary: `${limit.condition}: retrying when the limit resets at ${limit.resetsAt}.`,
    delayMs: dueMs - now,
    resumeAt: new Date(dueMs).toISOString(),
  };
}
