// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
//
// Session limit recovery — the user-driven counterpart to the policy's automatic
// resume (session-reroute.ts planResume).
//
// When a turn ends because the agent hit a provider usage/rate limit, or ran
// out of context, and no ruleset recovered it automatically, the session
// shouldn't just show a dead error. This decides whether the failure IS such a
// limit, and what the user can do about it: fork the work to another agent
// right away, opt in to retrying the same prompt automatically once the window
// resets, or continue in a fresh session that starts from a summary. The caller (server.ts)
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
  /** The provider refused a subscription sign-in for this agent (Anthropic bills
   *  apps other than Claude Code from extra usage), so waiting won't help. */
  planNotCovered?: boolean;
}

/** Anthropic's answer when a Claude plan sign-in is used outside Claude Code. */
const PLAN_NOT_COVERED = /third[\s-]party apps? (?:now )?draw from your extra usage/i;

/** The limits the notice offers a way past: how it describes each, the way
 *  out it offers, and whether waiting for a reset can help. Adding a condition
 *  is a row. Action ids are the client's (`fork` opens the fork sheet,
 *  `continue-fresh` forks into the same agent from the bounded hand-off). */
const LIMITS: Partial<Record<RuntimeCondition, { what: string; offer: string; actions: string[]; waitable: boolean }>> = {
  credits_exhausted: { what: "reached its usage limit", offer: "Fork to another agent to keep going", actions: ["fork"], waitable: true },
  rate_limited: { what: "is being rate-limited", offer: "Fork to another agent to keep going", actions: ["fork"], waitable: true },
  // The agent's own compaction has already run (or failed) by the time this
  // surfaces, so the way on is a new conversation, not the same one again.
  context_overflow: {
    what: "ran out of context: this conversation no longer fits its context window",
    offer: "A fresh session can pick up from a summary of it",
    actions: ["continue-fresh"],
    waitable: false,
  },
};

/** Retry a little after the stated reset: providers round reset times and a
 *  re-send that lands a few seconds early just hits the same limit again. */
const RESET_GRACE_MS = 60_000;

/** Classify a turn error; returns the limit it represents, or undefined when it
 *  is some other failure. `resetsAtHint` is the provider's structured reset time
 *  (see ClassifyOptions) and wins over anything scraped from the text. */
export function detectSessionLimit(
  error: unknown,
  opts: { now?: number; resetsAtHint?: string; conditionHint?: RuntimeCondition } = {},
): SessionLimit | undefined {
  const now = opts.now ?? Date.now();
  const classified = classifyFailure(error, { now, resetsAtHint: opts.resetsAtHint, conditionHint: opts.conditionHint });
  const limit = LIMITS[classified.condition];
  if (!limit) return undefined;
  const raw = error instanceof Error ? error.message : String(error ?? "");
  if (PLAN_NOT_COVERED.test(raw)) return { condition: classified.condition, planNotCovered: true };
  if (!limit.waitable) return { condition: classified.condition };
  const resetsAt = classified.resetsAt
    ?? (classified.retryAfterMs !== undefined ? new Date(now + classified.retryAfterMs).toISOString() : undefined);
  return { condition: classified.condition, ...(resetsAt ? { resetsAt } : {}) };
}

/** The notice offering the user a way past the limit. Actions are client
 *  action ids: `fork` opens the fork sheet; `retry-at-reset:<iso>` opts in to an
 *  automatic retry (the timestamp is only for the button's label — the daemon
 *  schedules from its own remembered limit). */
export function sessionLimitNotice(agentName: string, limit: SessionLimit): { message: string; actions: string[] } {
  if (limit.planNotCovered) {
    return {
      message: `${agentName} can't use your Claude plan: Anthropic only covers Claude Code with it and bills other apps from extra usage. Fork to Claude Code to keep going, or connect an Anthropic API key.`,
      actions: ["fork"],
    };
  }
  const row = LIMITS[limit.condition] ?? { what: "hit a limit", offer: "Fork to another agent to keep going", actions: ["fork"], waitable: true };
  const what = `${agentName} ${row.what}.`;
  return limit.resetsAt && row.waitable
    ? {
      message: `${what} ${row.offer}, or retry automatically when the limit resets.`,
      actions: [...row.actions, `retry-at-reset:${limit.resetsAt}`],
    }
    : { message: `${what} ${row.offer}.`, actions: row.actions };
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
