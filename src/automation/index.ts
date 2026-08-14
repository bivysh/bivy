// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Shared automation preflight and simulation evaluator. See docs/automation-evaluator.md.
export * from "./types.js";
export { effectiveEventRules, eventRuleMatches, labelsMatch, matchFirst, repoAllowed } from "./match.js";
export { findOverlaps } from "./overlap.js";
export { gateFromChecks, runPreflightChecks } from "./preflight.js";

import { findOverlaps } from "./overlap.js";
import { matchFirst } from "./match.js";
import { gateFromChecks, runPreflightChecks } from "./preflight.js";
import type { AutomationEvaluation, EvaluableAutomation, EvaluationEvent, PreflightSignals } from "./types.js";

/**
 * Compose a first-match explanation, overlap/shadow findings across the
 * candidate set, and the preflight checklist + save gate for one automation
 * into a single result. `candidates` should be pre-sorted by the caller in
 * first-match evaluation order.
 */
export function evaluateAutomation<T extends EvaluableAutomation>(input: {
  candidates: T[];
  event?: EvaluationEvent;
  signals?: PreflightSignals;
}): AutomationEvaluation<T> {
  const preflight = runPreflightChecks(input.signals ?? {});
  return {
    match: input.event ? matchFirst(input.candidates, input.event) : undefined,
    overlaps: findOverlaps(input.candidates),
    preflight,
    gate: gateFromChecks(preflight),
  };
}
