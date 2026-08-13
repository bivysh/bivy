// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Match inbound source events (GitHub, Linear) against account automation
// definitions. Schedule/webhook keep their own intake paths.
//
// GitHub model (general):
//   - One connection (the GitHub App).
//   - Automations are jobs: instructions + filters. Outcomes are whatever the
//     instructions say (comment, PR, fix, …) — nothing special-cased for PRs.
//   - `on: EventRule[]` describes which deliveries match. Legacy rows without
//     `on` (and legacy trigger=github_ci) expand to equivalent default rules.
import {
  effectiveEventRules as sharedEffectiveEventRules,
  eventRuleMatches as sharedEventRuleMatches,
  findOverlaps as sharedFindOverlaps,
  labelsMatch as sharedLabelsMatch,
  matchFirst,
  repoAllowed as sharedRepoAllowed,
  type EvaluableAutomation,
  type EvaluationEvent,
  type MatchTrailEntry,
  type OverlapFinding,
} from "@bivy/automation-core";
import type { AutomationDefinition } from "./store.js";

/** GitHub delivery families Bivy understands today. Grow this list; don't add
 *  new top-level trigger enums. */
export type GithubEventName =
  | "issues"
  | "issue_comment"
  | "pull_request"
  | "pull_request_review_comment"
  | "workflow_run";

/**
 * One "when" clause on a GitHub automation. Any matching rule fires the job.
 * Labels / @mention are predicates on surfaces that carry them — not separate
 * product triggers.
 */
export interface AutomationEventRule {
  event: GithubEventName;
  /** Optional action allowlist (e.g. labeled, opened, completed). Empty = any. */
  actions?: string[];
  /**
   * Label filter. Empty/undefined with no mention → default `bivy` / `bivy/<node>`.
   * When `mention` is true, labels are not required (mention is the intent).
   */
  labels?: string[];
  /** Require an @-mention of the app handle in body/comment text. */
  mention?: boolean;
  /** workflow_run: conclusion allowlist. Default when omitted: failure (+ cancelled). */
  conclusions?: string[];
  /** workflow_run: workflow name allowlist. Empty = any workflow. */
  workflows?: string[];
}

export type SourceTriggerKind = "github" | "linear" | "github_ci";

/** Normalized delivery used by the matcher (ingress fills this). */
export interface SourceTriggerEvent {
  /** Linear stays its own kind; GitHub (incl. legacy github_ci) uses github. */
  kind: "github" | "linear";
  /** owner/name when known */
  repo?: string;
  /** Labels on the issue / PR / ticket. */
  labels: string[];
  /** @-mention of the app was present. */
  mention?: boolean;
  /** GitHub X-GitHub-Event (required for kind=github). */
  githubEvent?: GithubEventName;
  /** GitHub action field when present. */
  action?: string;
  /** workflow_run name */
  workflowName?: string;
  /** workflow_run conclusion */
  conclusion?: string;
}

const SENTINEL_SCHEDULE = { kind: "once" as const, at: "9999-12-31T00:00:00.000Z" };

/** Plaintext default when a CI automation has no E2E template yet. */
export const DEFAULT_FIX_CI_PROMPT = `Investigate a failed CI build and prepare a tested fix.

1. Use the incoming event context (build URL, job name, conclusion) to locate the failure. Fetch logs with credentials already on this machine — never ask the event for secrets.
2. Reproduce the failure locally with the project's own test/CI commands.
3. Make the smallest safe fix. Do not refactor unrelated code.
4. Run the affected checks and the project's tests, linter, and type checks.
5. Commit on a new branch and open a pull request that links the failing build and summarises the root cause and the checks that passed.

If the failure cannot be reproduced or is clearly an infrastructure flake, make no code changes and report the evidence.`;

/** Built-in source automations seeded when a matching hook exists. */
export const SOURCE_AUTOMATION_SEEDS: Record<
  SourceTriggerKind,
  { name: string; templateId: string; labels?: string[]; on?: AutomationEventRule[] }
> = {
  github: {
    name: "Work issues into PRs",
    templateId: "issue-to-pr",
    labels: ["bivy"],
    on: [
      { event: "issues", labels: ["bivy"] },
      { event: "issue_comment", mention: true },
      { event: "pull_request", labels: ["bivy"] },
      { event: "pull_request_review_comment", mention: true },
    ],
  },
  linear: {
    name: "Work Linear issues into PRs",
    templateId: "issue-to-pr",
    labels: ["bivy"],
  },
  // Legacy kind kept for seed/list compatibility; matching expands to workflow_run rules.
  github_ci: {
    name: "Fix failed CI",
    templateId: "fix-ci",
    on: [
      {
        event: "workflow_run",
        actions: ["completed"],
        // Match parseGithubWorkflowRunFailure (success/skipped never enqueue).
        conclusions: ["failure", "timed_out", "startup_failure"],
      },
    ],
  },
};

export function isSourceTrigger(trigger: AutomationDefinition["trigger"]): trigger is SourceTriggerKind {
  return trigger === "github" || trigger === "linear" || trigger === "github_ci";
}

export function isGithubEventName(value: string): value is GithubEventName {
  return (
    value === "issues"
    || value === "issue_comment"
    || value === "pull_request"
    || value === "pull_request_review_comment"
    || value === "workflow_run"
  );
}

/**
 * Adapt a stored definition to the shape the shared evaluator understands.
 * `github_ci` is a control-plane-only legacy alias (config-as-code never had
 * it) that expands to an explicit workflow_run rule here, at the boundary,
 * rather than teaching the shared matcher a control-plane-specific trigger.
 */
function toEvaluable(def: AutomationDefinition): EvaluableAutomation & { createdAt: string; configOrder?: number; configKey?: string } {
  const legacyCiOn: AutomationEventRule[] | undefined = def.trigger === "github_ci" && !(def.on && def.on.length > 0)
    ? [{
        event: "workflow_run",
        actions: ["completed"],
        conclusions: ["failure", "timed_out", "startup_failure"],
        // Historical: labels[] on github_ci meant workflow name allowlist.
        workflows: def.labels?.length ? def.labels : undefined,
      }]
    : undefined;
  return {
    id: def.id,
    enabled: def.enabled !== false,
    trigger: def.trigger === "github_ci" ? "github" : (def.trigger ?? "schedule"),
    repo: def.repo,
    repos: def.repos,
    labels: def.labels,
    on: legacyCiOn ?? def.on,
    createdAt: def.createdAt,
    configOrder: def.configOrder,
    configKey: def.configKey,
  };
}

function toEvaluationEvent(event: SourceTriggerEvent): EvaluationEvent {
  return {
    kind: event.kind,
    repo: event.repo,
    labels: event.labels,
    mention: event.mention,
    event: event.githubEvent,
    action: event.action,
    conclusion: event.conclusion,
    workflow: event.workflowName,
  };
}

/**
 * Expand a definition to the rules that gate intake. Explicit `on` wins.
 * Legacy rows without `on` keep historical defaults so behavior doesn't flip.
 */
export function effectiveEventRules(def: AutomationDefinition): AutomationEventRule[] {
  return sharedEffectiveEventRules(toEvaluable(def));
}

/** Whether one rule matches a normalized GitHub delivery. */
export function eventRuleMatches(rule: AutomationEventRule, event: SourceTriggerEvent): boolean {
  return sharedEventRuleMatches(rule, toEvaluationEvent(event));
}

/**
 * First matching enabled source automation wins (stable: createdAt ascending,
 * with config-as-code file order preserved for source-controlled rows). Empty
 * `repos` on the definition means "all repos". Delegates the actual first-
 * match walk to the shared evaluator (src/automation) — see
 * docs/automation-evaluator.md — so this is the same contract config-as-code
 * `test` and the PWA Test event workflow explain.
 */
export function matchSourceAutomation(
  definitions: AutomationDefinition[],
  event: SourceTriggerEvent,
): AutomationDefinition | undefined {
  return explainSourceAutomationMatch(definitions, event).matched;
}

/** Same first-match walk as matchSourceAutomation, but returns the full
 *  per-candidate explanation trail. Powers the simulate endpoint. */
export function explainSourceAutomationMatch(
  definitions: AutomationDefinition[],
  event: SourceTriggerEvent,
): { matched?: AutomationDefinition; trail: MatchTrailEntry[] } {
  const byId = new Map(definitions.map((d) => [d.id, d]));
  const candidates = definitions
    .filter((d) => {
      if (d.enabled === false) return false;
      if (event.kind === "linear") return d.trigger === "linear";
      // GitHub deliveries match both modern github and legacy github_ci rows.
      return d.trigger === "github" || d.trigger === "github_ci";
    })
    .map(toEvaluable)
    .sort((a, b) => {
      // Definitions from one automations-as-code file preserve file order even
      // after an update (createdAt cannot represent a reorder). UI-managed and
      // mixed definitions retain the historical oldest-first contract.
      if (a.configKey && b.configKey && a.configOrder !== undefined && b.configOrder !== undefined) {
        return a.configOrder - b.configOrder || a.createdAt.localeCompare(b.createdAt);
      }
      return a.createdAt.localeCompare(b.createdAt);
    });

  const { matched, trail } = matchFirst(candidates, toEvaluationEvent(event));
  return { matched: matched ? byId.get(matched.id) : undefined, trail };
}

/** Overlap/shadow findings across an account's enabled github/linear
 *  automations, in the order matchSourceAutomation evaluates them. */
export function findAutomationOverlaps(definitions: AutomationDefinition[]): OverlapFinding[] {
  const candidates = definitions
    .filter((d) => d.enabled !== false && (d.trigger === "github" || d.trigger === "linear" || d.trigger === "github_ci"))
    .map(toEvaluable)
    .sort((a, b) => {
      if (a.configKey && b.configKey && a.configOrder !== undefined && b.configOrder !== undefined) {
        return a.configOrder - b.configOrder || a.createdAt.localeCompare(b.createdAt);
      }
      return a.createdAt.localeCompare(b.createdAt);
    });
  return sharedFindOverlaps(candidates);
}

/** Repo allowlist: undefined/empty = all; otherwise exact owner/name match. */
export function repoAllowed(allowlist: string[] | undefined, repo: string | undefined): boolean {
  return sharedRepoAllowed(allowlist, repo);
}

/**
 * Label filter. Default (no labels configured) accepts any label that starts
 * with `bivy` (historical contract: `bivy` or `bivy/<node>`). Explicit labels
 * match exactly or as a `label/<node>` prefix form.
 */
export function labelsMatch(filter: string[] | undefined, eventLabels: string[]): boolean {
  return sharedLabelsMatch(filter, eventLabels);
}

/** Normalize optional string arrays from API bodies. */
export function normalizeStringList(value: unknown, max = 50): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error("expected a string array");
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") throw new Error("expected a string array");
    const t = item.trim();
    if (!t) continue;
    if (t.length > 120) throw new Error("list entry too long");
    out.push(t);
    if (out.length > max) throw new Error(`at most ${max} entries`);
  }
  return out;
}

const GITHUB_EVENTS: readonly GithubEventName[] = [
  "issues",
  "issue_comment",
  "pull_request",
  "pull_request_review_comment",
  "workflow_run",
];

/** Validate/normalize `on` from an API body. */
export function normalizeEventRules(value: unknown): AutomationEventRule[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error("on must be an array of event rules");
  if (value.length > 20) throw new Error("at most 20 event rules");
  const out: AutomationEventRule[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") throw new Error("invalid event rule");
    const o = raw as Record<string, unknown>;
    const event = typeof o.event === "string" ? o.event.trim() : "";
    if (!isGithubEventName(event)) {
      throw new Error(`unsupported event "${event}"; expected one of ${GITHUB_EVENTS.join(", ")}`);
    }
    const rule: AutomationEventRule = { event };
    if (o.actions !== undefined) rule.actions = normalizeStringList(o.actions, 30);
    if (o.labels !== undefined) rule.labels = normalizeStringList(o.labels, 30);
    if (o.workflows !== undefined) rule.workflows = normalizeStringList(o.workflows, 30);
    if (o.conclusions !== undefined) rule.conclusions = normalizeStringList(o.conclusions, 20);
    if (o.mention === true) rule.mention = true;
    if (o.mention === false) rule.mention = false;
    out.push(rule);
  }
  return out;
}

/** Input for seeding a source automation when a hook exists but no definition does. */
export function sourceAutomationSeedInput(kind: SourceTriggerKind): Omit<
  AutomationDefinition,
  "id" | "accountId" | "createdAt" | "updatedAt"
> {
  const seed = SOURCE_AUTOMATION_SEEDS[kind];
  return {
    name: seed.name,
    templateId: seed.templateId,
    trigger: kind,
    labels: seed.labels,
    on: seed.on,
    enabled: kind === "github_ci" ? false : true, // CI opt-in; issue-to-pr on by default
    // Park off the scheduler — source automations fire from webhooks only.
    schedule: SENTINEL_SCHEDULE,
    nextRunAt: undefined,
  };
}
