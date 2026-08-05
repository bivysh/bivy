// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
//
// Typed runtime-failure conditions + a classifier.
//
// This is the load-bearing seam of policy-driven run orchestration: rules match
// STABLE condition codes, never raw provider error strings. A raw failure (an
// opaque `429`, a `credit balance is too low`, a socket hang-up) is classified
// here exactly once into a `RuntimeCondition` plus whatever recovery metadata we
// could recover (a `retryAfterMs`, a `resetsAt`), and every downstream rule,
// evidence event, and effector speaks only that vocabulary. Add a new provider
// quirk here and the whole policy layer understands it — no rule edits, no
// regexes scattered through runtimes and the queue poller.

import { isAnthropicAuthError } from "../runtime/anthropic-preflight.js";

/** Stable, provider-agnostic failure classes a ruleset can match on. */
export type RuntimeCondition =
  | "rate_limited" // 429/overloaded — provider asked us to slow down; retry later
  | "credits_exhausted" // quota/credit/billing allowance spent — needs a different route
  | "context_overflow" // conversation/context window full — needs a fresh session
  | "auth_failed" // 401/expired/revoked credential — needs a human or a refresh
  | "node_offline" // the compute node/host is unreachable
  | "transport_error" // transient network/relay/timeout — retry with backoff
  | "task_failed" // the agent ran but the work failed (tests red, no progress)
  | "unknown"; // unclassified — deliberately NOT auto-recovered

/** A raw failure resolved into a condition plus any recovery hints we parsed. */
export interface ClassifiedFailure {
  condition: RuntimeCondition;
  /** Milliseconds the provider asked us to wait before retrying, if it said. */
  retryAfterMs?: number;
  /** ISO timestamp a quota/limit window resets at, if the provider said. */
  resetsAt?: string;
  /** The bounded, lower-cased raw text the classifier matched against. */
  raw: string;
}

/** Optional context for the classifier. */
export interface ClassifyOptions {
  /** Wall clock (ms) used to resolve a bare "resets 12am" into an absolute
   *  instant. Defaults to Date.now(). Injectable for deterministic tests. */
  now?: number;
  /** An authoritative reset timestamp the caller already knows (e.g. from the
   *  provider's structured usage snapshot). Takes priority over anything we can
   *  scrape from the error text — the text of a weekly limit only says the
   *  time-of-day, never which day, so the structured hint is the only reliable
   *  source for a multi-day window. Only used for the wait-and-retry conditions. */
  resetsAtHint?: string;
}

function rawText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

/** Parse a "wait N" hint from a raw error into milliseconds, if present. */
export function parseRetryAfterMs(raw: string): number | undefined {
  // `retry-after: 30` / `retry_after=30` (seconds, HTTP-style).
  const header = /retry[\s_-]?after["'\s:=]+(\d{1,5})/i.exec(raw);
  if (header?.[1]) return Number(header[1]) * 1000;
  // "try again in 12 seconds" / "retry in 5 minutes".
  const phrase = /(?:try again|retry)\s+in\s+(\d{1,5})\s*(ms|s|sec|second|m|min|minute|h|hour)/i.exec(raw);
  if (phrase?.[1]) {
    const n = Number(phrase[1]);
    const unit = phrase[2]!.toLowerCase();
    if (unit === "ms") return n;
    if (unit.startsWith("h")) return n * 3_600_000;
    if (unit.startsWith("m") && unit !== "ms") return n * 60_000;
    return n * 1000;
  }
  return undefined;
}

/** Parse an ISO reset timestamp (e.g. `resets_at: 2026-07-27T18:00:00Z`). */
export function parseResetsAt(raw: string): string | undefined {
  const iso = /(20\d\d-\d\d-\d\dT[\d:.]+(?:Z|[+-]\d\d:?\d\d))/.exec(raw);
  return iso?.[1];
}

/**
 * Parse a bare wall-clock reset time — the shape Claude's subscription limits
 * surface, e.g. `resets 12am (UTC)`, `resets at 3pm UTC`, `resets 09:00 UTC` —
 * into the ISO timestamp of its NEXT occurrence (interpreted as UTC, which is
 * what these messages state). Returns undefined when there's no clear clock
 * time, so a relative phrase ("resets in 2 hours", handled by
 * parseRetryAfterMs) or an unrelated number never masquerades as a reset.
 *
 * NB: a bare time-of-day can't say WHICH day, so for a multi-day window (a
 * "weekly limit") this resolves to the nearest matching midnight, which may be
 * earlier than the real reset. Prefer a structured resetsAtHint when available.
 */
export function parseResetClock(raw: string, nowMs: number): string | undefined {
  const m = /reset[a-z]*\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(raw);
  if (!m) return undefined;
  const meridiem = m[3]?.toLowerCase();
  // Require a real clock signal — a meridiem, an explicit minutes field, or a
  // trailing UTC/GMT marker — so a bare "resets 5 nodes" can't parse as 05:00.
  const tzFollows = /\b(?:utc|gmt)\b/i.test(raw.slice(m.index));
  if (!meridiem && m[2] === undefined && !tzFollows) return undefined;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  if (hour > 23 || minute > 59) return undefined;
  if (meridiem === "am") { if (hour === 12) hour = 0; }
  else if (meridiem === "pm") { if (hour !== 12) hour += 12; }
  if (hour > 23) return undefined;
  const now = new Date(nowMs);
  let target = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute, 0, 0);
  if (target <= nowMs) target += 86_400_000; // already past today → next day's occurrence
  return new Date(target).toISOString();
}

// Ordered classifiers: the FIRST match wins, so more-specific/actionable
// conditions are tested before broader ones (auth 401 before generic HTTP
// noise; explicit billing/quota before a bare rate-limit; context-window before
// a generic "too long").
const CLASSIFIERS: { condition: RuntimeCondition; test: (raw: string) => boolean }[] = [
  { condition: "auth_failed", test: (r) => isAnthropicAuthError(r) },
  {
    condition: "credits_exhausted",
    // Includes subscription usage caps — a Claude "5-hour" or "weekly" window
    // hit reads "you've hit your weekly limit · resets 12am (UTC)". The window
    // qualifier (weekly/daily/5-hour/7-day) is optional and may sit between
    // "your" and "limit", so it must not break the match (it did before — the
    // word "weekly" left these limits classified "unknown" and never resumed).
    test: (r) =>
      /\b402\b|payment required|insufficient\s+(?:credit|quota|balance|funds)|credit balance (?:is )?too low|quota (?:exceeded|exhausted)|billing|(?:usage|session|weekly|daily|monthly|5[\s-]?hour|7[\s-]?day)[\s-]?limit(?:\s+(?:reached|hit))?|(?:you(?:'ve| have)\s+)?hit your (?:(?:weekly|daily|monthly|session|usage|5[\s-]?hour|7[\s-]?day)\s+)?limit|out of credits|plan (?:limit|allowance)/i.test(
        r,
      ),
  },
  {
    condition: "rate_limited",
    test: (r) => /\b429\b|\b529\b|rate[\s_-]?limit|too many requests|overloaded/i.test(r),
  },
  {
    condition: "context_overflow",
    test: (r) =>
      /context[\s_-]?(?:length|window|limit)|maximum context|prompt is too long|too many tokens|exceeds?\b[^.]*\btokens?\b/i.test(
        r,
      ),
  },
  {
    condition: "node_offline",
    test: (r) => /ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|no route to host|node (?:is )?offline|host unreachable/i.test(r),
  },
  {
    condition: "transport_error",
    test: (r) =>
      /ETIMEDOUT|ECONNRESET|EPIPE|EAI_AGAIN|ENOTFOUND|socket hang ?up|network (?:error|timeout)|fetch failed|timed? ?out|temporarily unavailable|\b50[234]\b/i.test(
        r,
      ),
  },
  {
    condition: "task_failed",
    test: (r) => /tests? failed|checks? failed|no progress|made no changes|nothing to commit|assertion/i.test(r),
  },
];

/**
 * Classify a raw runtime failure into a stable `RuntimeCondition` plus any
 * recovery metadata. Unmatched failures are `"unknown"` — deliberately left for
 * a human rather than blindly retried.
 */
export function classifyFailure(error: unknown, opts: ClassifyOptions = {}): ClassifiedFailure {
  const raw = rawText(error).slice(0, 2000);
  const condition = CLASSIFIERS.find((c) => c.test(raw))?.condition ?? "unknown";
  const out: ClassifiedFailure = { condition, raw };
  // Recovery hints are only meaningful for the wait-and-retry conditions.
  if (condition === "rate_limited" || condition === "credits_exhausted") {
    const retryAfterMs = parseRetryAfterMs(raw);
    if (retryAfterMs !== undefined) out.retryAfterMs = retryAfterMs;
    // Reset time, most-authoritative first: a structured hint the caller
    // supplied (the provider's own usage snapshot), then an ISO stamp in the
    // text, then a bare wall-clock ("resets 12am (UTC)") resolved to its next
    // occurrence.
    const resetsAt = opts.resetsAtHint ?? parseResetsAt(raw) ?? parseResetClock(raw, opts.now ?? Date.now());
    if (resetsAt !== undefined) out.resetsAt = resetsAt;
  }
  return out;
}
