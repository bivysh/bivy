// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// The ruleset schema + validator + the pure matcher.
//
// A ruleset is user-authored policy: which failures are recoverable, how to
// recover (retry / reroute through a fallback chain / park for a human), and the
// bounds (max attempts, backoff). It is validated once with typebox into a
// versioned in-memory shape — we never execute arbitrary YAML expressions — and
// the same ruleset serves both the interactive session and the work queue,
// gated by `appliesTo`. The MATCHER here is pure: `(ruleset, condition,
// context) → Rule | undefined`. How the chosen rule is carried out lives in the
// context-specific effectors (see run-policy.ts for the queue effector).

import { Type, type Static } from "typebox";
import { Check, Errors } from "typebox/value";
import type { RuntimeCondition } from "./conditions.js";

/** Where a rule may fire. A rule naming a context it isn't `appliesTo` is inert. */
export type RuleContext = "session" | "queue";

// ── Schema (typebox) ────────────────────────────────────────────────────────
// Declared with typebox so a ruleset loaded from disk/YAML is validated before
// it can steer a live run. Kept intentionally small for v1: the reroute slice.
// The literals are spelled out (not mapped) so typebox infers the union type.

const ConditionSchema = Type.Union([
  Type.Literal("rate_limited"),
  Type.Literal("credits_exhausted"),
  Type.Literal("context_overflow"),
  Type.Literal("auth_failed"),
  Type.Literal("node_offline"),
  Type.Literal("transport_error"),
  Type.Literal("task_failed"),
  Type.Literal("unknown"),
]);

const RoutingCandidateSchema = Type.Object(
  {
    runtimeId: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    /** Provider/account id to route through — matched against configured creds. */
    account: Type.Optional(Type.String()),
    /** Human-readable label for evidence, if none is derivable. */
    label: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const BackoffSchema = Type.Object(
  {
    baseMs: Type.Integer({ minimum: 0 }),
    factor: Type.Number({ minimum: 1 }),
    capMs: Type.Integer({ minimum: 0 }),
    jitter: Type.Number({ minimum: 0, maximum: 1 }),
  },
  { additionalProperties: false },
);

const RuleSchema = Type.Object(
  {
    when: Type.Array(ConditionSchema, { minItems: 1 }),
    action: Type.Union([Type.Literal("retry"), Type.Literal("reroute"), Type.Literal("park")]),
    /** Ordered fallback candidates for `reroute`; first with valid creds wins. */
    chain: Type.Optional(Type.Array(RoutingCandidateSchema)),
    /** What to do when retries/chain are exhausted. Defaults to `park`. */
    onExhausted: Type.Optional(Type.Union([Type.Literal("park"), Type.Literal("give_up")])),
    maxAttempts: Type.Integer({ minimum: 1, maximum: 100 }),
    backoff: Type.Optional(BackoffSchema),
  },
  { additionalProperties: false },
);

export const RulesetSchema = Type.Object(
  {
    /** Schema version — lets stored rulesets migrate without silent misreads. */
    version: Type.Literal(1),
    name: Type.String({ minLength: 1 }),
    appliesTo: Type.Array(Type.Union([Type.Literal("session"), Type.Literal("queue")]), { minItems: 1 }),
    rules: Type.Array(RuleSchema),
  },
  { additionalProperties: false },
);

export type RoutingCandidate = Static<typeof RoutingCandidateSchema>;
export type BackoffConfig = Static<typeof BackoffSchema>;
export type Rule = Static<typeof RuleSchema>;
export type Ruleset = Static<typeof RulesetSchema>;

/** Backoff used when a retry/reroute rule doesn't specify one. Mirrors the
 *  reconnect layer's defaults (see src/session/reconnect.ts BackoffOptions). */
export const DEFAULT_BACKOFF: BackoffConfig = { baseMs: 2000, factor: 2, capMs: 60_000, jitter: 0.3 };

/**
 * The built-in default ruleset — deliberately SAFE, not clever.
 *
 * Infra hiccups (transient transport, provider rate-limits) retry with backoff;
 * quota/auth/context failures are PARKED for a human (we can't presume a valid
 * fallback model or account for an arbitrary node); genuine task failures and
 * anything unclassified fall through to the caller's existing failure path.
 * Reroute + fallback chains are fully supported (see run-policy.ts) but opt-in:
 * author a rule with a `chain` to enable cross-account/model/provider fallback.
 */
export const DEFAULT_RULESET: Ruleset = {
  version: 1,
  name: "default",
  appliesTo: ["queue", "session"],
  rules: [
    { when: ["transport_error", "node_offline"], action: "retry", maxAttempts: 3, backoff: DEFAULT_BACKOFF },
    {
      when: ["rate_limited"],
      action: "retry",
      maxAttempts: 4,
      backoff: { baseMs: 5000, factor: 2, capMs: 120_000, jitter: 0.3 },
    },
    { when: ["credits_exhausted"], action: "park", maxAttempts: 1 },
    { when: ["context_overflow"], action: "park", maxAttempts: 1 },
    { when: ["auth_failed"], action: "park", maxAttempts: 1 },
  ],
};

export interface RulesetValidation {
  ok: boolean;
  ruleset?: Ruleset;
  errors: string[];
}

/**
 * Validate an untrusted value (e.g. parsed from a user's YAML/JSON) against the
 * ruleset schema. Returns the typed ruleset on success, or a bounded list of
 * human-readable errors — never throws.
 */
export function validateRuleset(value: unknown): RulesetValidation {
  if (Check(RulesetSchema, value)) {
    const ruleset = value as Ruleset;
    const errors: string[] = [];
    for (let ruleIndex = 0; ruleIndex < ruleset.rules.length; ruleIndex += 1) {
      const rule = ruleset.rules[ruleIndex]!;
      if (rule.action !== "reroute" || !rule.chain) continue;
      for (let candidateIndex = 0; candidateIndex < rule.chain.length; candidateIndex += 1) {
        const candidate = rule.chain[candidateIndex]!;
        const hasRoute = [candidate.runtimeId, candidate.model, candidate.account]
          .some((field) => typeof field === "string" && field.trim().length > 0);
        if (!hasRoute) errors.push(`/rules/${ruleIndex}/chain/${candidateIndex}: fallback candidate must specify runtimeId, model, or account`);
      }
    }
    if (errors.length) return { ok: false, errors };
    return { ok: true, ruleset, errors: [] };
  }
  const errors = [...Errors(RulesetSchema, value)]
    .slice(0, 20)
    .map((e) => `${(e as { path?: string }).path || "/"}: ${e.message}`);
  return { ok: false, errors: errors.length ? errors : ["ruleset did not match the expected shape"] };
}

/**
 * The pure matcher: the first rule that applies to `context` and lists
 * `condition` in its `when`. Undefined means "no policy for this failure" — the
 * caller keeps its existing behavior (e.g. fail the run).
 */
export function findRule(ruleset: Ruleset, condition: RuntimeCondition, context: RuleContext): Rule | undefined {
  if (!ruleset.appliesTo.includes(context)) return undefined;
  return ruleset.rules.find((rule) => rule.when.includes(condition));
}
