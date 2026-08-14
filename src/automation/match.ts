// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// First-match automation evaluation. This is the single canonical
// implementation of "which enabled automation fires for this event" — before
// this module existed, src/automation-config.ts (config-as-code `test`) and
// services/control-plane/src/automation-match.ts (live webhook intake) each
// hand-rolled an equivalent-but-not-identical matcher. Both now delegate here.
//
// Contract (docs/automations-as-code.md): first enabled candidate, in the
// order the caller provides, whose repository scope and event rules match,
// wins. Callers own ordering (config-as-code uses file order; control-plane
// sorts by configOrder/createdAt) — this module never reorders candidates.
import type {
  EvaluableAutomation,
  EvaluableEventRule,
  EvaluationEvent,
  GithubEventName,
  MatchResult,
  MatchTrailEntry,
} from "./types.js";

const DEFAULT_WORKFLOW_CONCLUSIONS = ["failure", "timed_out", "startup_failure"];
const DEFAULT_LABEL_FILTER = ["bivy"];

/** Repo allowlist: undefined/empty = all; otherwise exact owner/name match. */
export function repoAllowed(allowlist: string[] | undefined, repo: string | undefined): boolean {
  if (!allowlist || allowlist.length === 0) return true;
  if (!repo) return false;
  const want = repo.trim().toLowerCase();
  return allowlist.some((r) => r.trim().toLowerCase() === want);
}

/**
 * Label filter. Default (no labels configured) accepts any label that starts
 * with `bivy` (historical contract: `bivy` or `bivy/<node>`). Explicit labels
 * match exactly or as a `label/<node>` prefix form.
 */
export function labelsMatch(filter: string[] | undefined, eventLabels: string[] | undefined): boolean {
  const normalized = (eventLabels ?? []).map((l) => l.trim().toLowerCase()).filter(Boolean);
  const filters = (filter && filter.length > 0 ? filter : DEFAULT_LABEL_FILTER).map((l) => l.trim().toLowerCase()).filter(Boolean);
  if (filters.length === 0) return true;
  return normalized.some((label) => filters.some((f) => label === f || label.startsWith(`${f}/`)));
}

function actionAllowed(rule: EvaluableEventRule, action: string | undefined): boolean {
  if (!rule.actions?.length) return true;
  if (!action) return false;
  const want = action.trim().toLowerCase();
  return rule.actions.some((a) => a.trim().toLowerCase() === want);
}

function conclusionAllowed(rule: EvaluableEventRule, conclusion: string | undefined): boolean {
  const allowed = (rule.conclusions?.length ? rule.conclusions : DEFAULT_WORKFLOW_CONCLUSIONS).map((c) => c.trim().toLowerCase());
  if (!conclusion) return false;
  return allowed.includes(conclusion.trim().toLowerCase());
}

function workflowAllowed(rule: EvaluableEventRule, workflow: string | undefined): boolean {
  if (!rule.workflows?.length) return true;
  if (!workflow) return false;
  const want = workflow.trim().toLowerCase();
  return rule.workflows.some((w) => w.trim().toLowerCase() === want);
}

/** Whether one `on[]` rule matches a normalized GitHub event. */
export function eventRuleMatches(rule: EvaluableEventRule, event: EvaluationEvent): boolean {
  if (event.kind !== "github") return false;
  if (event.event !== rule.event) return false;
  if (!actionAllowed(rule, event.action)) return false;

  if (rule.event === "workflow_run") {
    if (!conclusionAllowed(rule, event.conclusion)) return false;
    if (!workflowAllowed(rule, event.workflow)) return false;
    return true;
  }

  // Actor-driven surfaces: mention and/or labels.
  if (rule.mention) {
    if (!event.mention) return false;
    // Mention is sufficient intent; optional extra label constraint if both set.
    if (rule.labels?.length && !labelsMatch(rule.labels, event.labels)) return false;
    return true;
  }

  // Label-gated (default bivy* when labels omitted).
  return labelsMatch(rule.labels, event.labels);
}

/**
 * Expand a definition to the rules that gate intake. Explicit `on` wins.
 * Legacy rows without `on` keep historical defaults so behavior doesn't flip.
 */
export function effectiveEventRules(def: Pick<EvaluableAutomation, "trigger" | "on" | "labels">): EvaluableEventRule[] {
  if (def.on && def.on.length > 0) return def.on;

  if (def.trigger === "github") {
    // Pre-`on` github automations: issues + issue comments only (no silent PR enable).
    const rules: EvaluableEventRule[] = [
      { event: "issues" as GithubEventName, labels: def.labels },
      { event: "issue_comment" as GithubEventName, mention: true },
    ];
    return rules;
  }

  return [];
}

/**
 * First matching enabled automation wins, in the order `automations` is
 * given. Returns a per-candidate explanation trail — this is what powers
 * `bivy automation test`, the control-plane simulate endpoint, and the PWA
 * Test event workflow.
 */
export function matchFirst<T extends EvaluableAutomation>(
  automations: T[],
  event: EvaluationEvent,
): MatchResult<T> {
  const trail: MatchTrailEntry[] = [];
  for (const def of automations) {
    if (!def.enabled) {
      trail.push({ id: def.id, matched: false, reason: "disabled" });
      continue;
    }
    if (def.trigger !== event.kind) {
      trail.push({ id: def.id, matched: false, reason: `trigger is ${def.trigger}` });
      continue;
    }
    const allowedRepos = def.repos?.length ? def.repos : def.repo ? [def.repo] : undefined;
    if (!repoAllowed(allowedRepos, event.repo)) {
      trail.push({ id: def.id, matched: false, reason: "repository is not allowed" });
      continue;
    }
    if (event.kind === "linear") {
      if (!event.mention && !labelsMatch(def.labels, event.labels)) {
        trail.push({ id: def.id, matched: false, reason: "labels do not match" });
        continue;
      }
      trail.push({ id: def.id, matched: true, reason: "first matching enabled automation" });
      return { matched: def, trail };
    }
    if (event.kind === "github") {
      const rules = effectiveEventRules(def);
      if (rules.length === 0 || !rules.some((rule) => eventRuleMatches(rule, event))) {
        trail.push({ id: def.id, matched: false, reason: "no event rule matched" });
        continue;
      }
      trail.push({ id: def.id, matched: true, reason: "first matching enabled automation" });
      return { matched: def, trail };
    }
    // schedule/webhook/manual: no event-rule contract, these fire via their
    // own intake (cron occurrence, signed POST, direct trigger) rather than
    // through matchFirst. Reaching here with such an event means the caller
    // is testing a definition-only fixture; report a plain match.
    trail.push({ id: def.id, matched: true, reason: "first matching enabled automation" });
    return { matched: def, trail };
  }
  return { trail };
}
