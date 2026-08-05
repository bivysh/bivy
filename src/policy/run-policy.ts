// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
//
// Run policy: the pure decision layer the queue effector drives.
//
// Given a failed attempt (its current routing, the raw error, the attempt count,
// and how many reroutes have already been applied), it classifies the failure,
// finds the matching rule, and returns ONE decision: retry (with a backoff
// delay), reroute (to the next credentialed candidate in the rule's chain), park
// (hand to a human), or give_up (no policy — keep the caller's existing
// behavior). It touches no I/O and no clock beyond an injectable `random`, so
// it's fully deterministic and unit-testable. The poller (src/control-plane-
// tasks.ts) is the effector that carries the decision out on the live run.

import { classifyFailure, type RuntimeCondition } from "./conditions.js";
import {
  DEFAULT_BACKOFF,
  DEFAULT_RULESET,
  findRule,
  type BackoffConfig,
  type RoutingCandidate,
  type RuleContext,
  type Ruleset,
} from "./ruleset.js";

/** The mutable routing knobs a reroute can change on the next attempt. */
export interface RunRouting {
  runtimeId?: string;
  model?: string;
  account?: string;
}

export interface RunFailureContext {
  /** The routing the attempt that just failed ran with. */
  routing: RunRouting;
  /** The raw error thrown by the attempt. */
  error: unknown;
  /** 1-based count of the attempt that just failed. */
  attempt: number;
  /** How many reroutes have already been applied to this run. */
  rerouteCount: number;
  /** An authoritative reset timestamp the effector already knows (e.g. from the
   *  provider's structured usage snapshot), preferred over anything scraped from
   *  the error text. See ClassifyOptions.resetsAtHint. */
  resetsAtHint?: string;
}

export type RunDecision =
  | {
      action: "retry";
      delayMs: number;
      condition: RuntimeCondition;
      summary: string;
      /** ISO reset time the delay is honoring, when one was known — lets an
       *  effector present/persist "resuming at X" rather than a bare delay. */
      resetsAt?: string;
    }
  | {
      action: "reroute";
      delayMs: number;
      condition: RuntimeCondition;
      routing: RunRouting;
      /** Bounded, evidence-safe label of where we rerouted to. */
      ref: string;
      /** The new reroute cursor the caller must carry into the next attempt. */
      rerouteCount: number;
      summary: string;
    }
  | { action: "park"; condition: RuntimeCondition; summary: string }
  | { action: "give_up"; condition: RuntimeCondition };

export interface RunPolicy {
  decide(ctx: RunFailureContext): RunDecision;
}

export interface RunPolicyDeps {
  /** Defaults to DEFAULT_RULESET. */
  ruleset?: Ruleset;
  /** Which effector is asking. Defaults to "queue". */
  context?: RuleContext;
  /** Returns false only when a candidate is PROVABLY missing credentials, so we
   *  skip it in the chain. Defaults to always-true (never skip). */
  hasCredential?: (candidate: RoutingCandidate) => boolean;
  /** Injectable RNG for deterministic jitter in tests. Defaults to Math.random. */
  random?: () => number;
  /** Injectable wall clock for turning a provider reset timestamp into a wait. */
  now?: () => number;
}

/** `min(cap, base·factor^n)` spread by ±jitter/2 — the reconnect-layer formula. */
export function computeBackoffMs(cfg: BackoffConfig, n: number, random: () => number): number {
  const raw = Math.min(cfg.capMs, cfg.baseMs * Math.pow(cfg.factor, n));
  const spread = raw * cfg.jitter * (random() - 0.5);
  return Math.max(0, Math.round(raw + spread));
}

function candidateRef(c: RoutingCandidate): string {
  return (
    c.label ||
    [c.runtimeId, c.model, c.account && `@${c.account}`].filter(Boolean).join(" / ") ||
    "fallback route"
  );
}

/** Build a run policy bound to a ruleset. Stateless: all per-run state (attempt,
 *  rerouteCount) is passed in, so one instance safely serves every run. */
export function createRunPolicy(deps: RunPolicyDeps = {}): RunPolicy {
  const ruleset = deps.ruleset ?? DEFAULT_RULESET;
  const context = deps.context ?? "queue";
  const hasCredential = deps.hasCredential ?? (() => true);
  const random = deps.random ?? Math.random;
  const now = deps.now ?? Date.now;

  return {
    decide(ctx: RunFailureContext): RunDecision {
      const classified = classifyFailure(ctx.error, { now: now(), resetsAtHint: ctx.resetsAtHint });
      const { condition } = classified;
      const rule = findRule(ruleset, condition, context);
      if (!rule) return { action: "give_up", condition };

      const exhausted = ctx.attempt >= rule.maxAttempts;
      const nextAttempt = ctx.attempt + 1;
      const backoff = rule.backoff ?? DEFAULT_BACKOFF;
      // A provider-supplied reset is the most precise recovery time. This is
      // especially important for session/usage limits: retrying with ordinary
      // backoff before the window resets only burns attempts. A relative
      // Retry-After is the next-best hint; otherwise use authored backoff.
      const resetAtMs = classified.resetsAt === undefined ? undefined : Date.parse(classified.resetsAt);
      const resetDelayMs = resetAtMs !== undefined && Number.isFinite(resetAtMs)
        ? Math.max(0, resetAtMs - now())
        : undefined;
      const delayMs = resetDelayMs ?? classified.retryAfterMs ?? computeBackoffMs(backoff, ctx.attempt - 1, random);

      const onExhausted = (): RunDecision =>
        rule.onExhausted === "give_up"
          ? { action: "give_up", condition }
          : {
              action: "park",
              condition,
              summary: `${condition}: no recovery left after ${ctx.attempt} attempt(s) — needs attention.`,
            };

      if (rule.action === "park") {
        return { action: "park", condition, summary: `${condition}: parked for a human — no automatic recovery.` };
      }

      if (rule.action === "retry") {
        if (exhausted) return onExhausted();
        const wait = Math.round(delayMs / 1000);
        const timing = resetDelayMs !== undefined && classified.resetsAt
          ? ` when the limit resets at ${classified.resetsAt}`
          : wait ? ` in ~${wait}s` : "";
        return {
          action: "retry",
          delayMs,
          condition,
          summary: `${condition}: transient — retrying (attempt ${nextAttempt}/${rule.maxAttempts})${timing}.`,
          ...(resetDelayMs !== undefined && classified.resetsAt ? { resetsAt: classified.resetsAt } : {}),
        };
      }

      // action === "reroute": walk the chain from the current cursor, skipping
      // any candidate we can prove lacks credentials on this node, or that is a
      // no-op (a pure model change equal to the model we're already on).
      const chain = rule.chain ?? [];
      const isNoop = (c: RoutingCandidate): boolean =>
        c.model !== undefined && c.model === ctx.routing.model && c.runtimeId === undefined && c.account === undefined;
      let cursor = ctx.rerouteCount;
      while (cursor < chain.length && (!hasCredential(chain[cursor]!) || isNoop(chain[cursor]!))) cursor += 1;
      if (exhausted || cursor >= chain.length) return onExhausted();

      const candidate = chain[cursor]!;
      const routing: RunRouting = {};
      if (candidate.runtimeId !== undefined) routing.runtimeId = candidate.runtimeId;
      if (candidate.model !== undefined) routing.model = candidate.model;
      if (candidate.account !== undefined) routing.account = candidate.account;
      const ref = candidateRef(candidate);
      return {
        action: "reroute",
        delayMs,
        condition,
        routing,
        ref,
        rerouteCount: cursor + 1,
        summary: `${condition}: rerouting to ${ref} (attempt ${nextAttempt}).`,
      };
    },
  };
}
