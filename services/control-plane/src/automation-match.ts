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
 * Expand a definition to the rules that gate intake. Explicit `on` wins.
 * Legacy rows without `on` keep historical defaults so behavior doesn't flip.
 */
export function effectiveEventRules(def: AutomationDefinition): AutomationEventRule[] {
  if (def.on && def.on.length > 0) return def.on;

  if (def.trigger === "github_ci") {
    return [
      {
        event: "workflow_run",
        actions: ["completed"],
        conclusions: ["failure", "timed_out", "startup_failure"],
        // Historical: labels[] on github_ci meant workflow name allowlist.
        workflows: def.labels?.length ? def.labels : undefined,
      },
    ];
  }

  if (def.trigger === "github") {
    // Pre-`on` github automations: issues + issue comments only (no silent PR enable).
    return [
      { event: "issues", labels: def.labels },
      { event: "issue_comment", mention: true },
    ];
  }

  return [];
}

function actionAllowed(rule: AutomationEventRule, action: string | undefined): boolean {
  if (!rule.actions?.length) return true;
  if (!action) return false;
  const want = action.toLowerCase();
  return rule.actions.some((a) => a.trim().toLowerCase() === want);
}

function conclusionAllowed(rule: AutomationEventRule, conclusion: string | undefined): boolean {
  const allowed = (rule.conclusions?.length
    ? rule.conclusions
    : ["failure", "timed_out", "startup_failure"])
    .map((c) => c.trim().toLowerCase());
  if (!conclusion) return false;
  return allowed.includes(conclusion.trim().toLowerCase());
}

function workflowAllowed(rule: AutomationEventRule, workflowName: string | undefined): boolean {
  if (!rule.workflows?.length) return true;
  if (!workflowName) return false;
  const want = workflowName.trim().toLowerCase();
  return rule.workflows.some((w) => w.trim().toLowerCase() === want);
}

/** Whether one rule matches a normalized GitHub delivery. */
export function eventRuleMatches(rule: AutomationEventRule, event: SourceTriggerEvent): boolean {
  if (event.kind !== "github") return false;
  if (event.githubEvent !== rule.event) return false;
  if (!actionAllowed(rule, event.action)) return false;

  if (rule.event === "workflow_run") {
    if (!conclusionAllowed(rule, event.conclusion)) return false;
    if (!workflowAllowed(rule, event.workflowName)) return false;
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
 * First matching enabled source automation wins (stable: createdAt ascending).
 * Empty `repos` on the definition means "all repos".
 */
export function matchSourceAutomation(
  definitions: AutomationDefinition[],
  event: SourceTriggerEvent,
): AutomationDefinition | undefined {
  const candidates = definitions
    .filter((d) => {
      if (d.enabled === false) return false;
      if (event.kind === "linear") return d.trigger === "linear";
      // GitHub deliveries match both modern github and legacy github_ci rows.
      return d.trigger === "github" || d.trigger === "github_ci";
    })
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  for (const def of candidates) {
    if (!repoAllowed(def.repos, event.repo)) continue;

    if (event.kind === "linear") {
      // Linear keeps the simple label contract (no `on` rules yet).
      if (!event.mention && !labelsMatch(def.labels, event.labels)) continue;
      return def;
    }

    const rules = effectiveEventRules(def);
    if (rules.length === 0) continue;
    if (rules.some((rule) => eventRuleMatches(rule, event))) return def;
  }
  return undefined;
}

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
export function labelsMatch(filter: string[] | undefined, eventLabels: string[]): boolean {
  const normalized = eventLabels.map((l) => l.trim().toLowerCase()).filter(Boolean);
  const filters = (filter && filter.length > 0 ? filter : ["bivy"]).map((l) => l.trim().toLowerCase()).filter(Boolean);
  if (filters.length === 0) return true;
  return normalized.some((label) =>
    filters.some((f) => label === f || label.startsWith(`${f}/`)),
  );
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
