// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
/**
 * Version-controlled automation configuration.
 *
 * This module is deliberately pure: the CLI uses it for validate/plan/test and
 * apply only sends the normalized result after all errors have been reported.
 */
import { parse as parseYaml } from "yaml";
import { matchFirst } from "./automation/index.js";

export const AUTOMATION_CONFIG_VERSION = 1 as const;
export const DEFAULT_AUTOMATION_CONFIG_PATH = ".bivy/automations.yaml";

export type AutomationTrigger = "github" | "linear" | "schedule" | "webhook" | "manual";
export type ApprovalMode = "never" | "risky" | "always" | "autonomous";
export type SandboxTier = "read-only" | "workspace-write" | "danger-full-access";
export type GithubEventName = "issues" | "issue_comment" | "pull_request" | "pull_request_review_comment" | "workflow_run";

export interface AutomationEventRule {
  event: GithubEventName;
  actions?: string[];
  labels?: string[];
  mention?: boolean;
  conclusions?: string[];
  workflows?: string[];
}

export interface AutomationConfigEntry {
  id: string;
  name: string;
  enabled: boolean;
  instructions: string;
  trigger: AutomationTrigger;
  schedule?: { kind: "once"; at: string } | { kind: "cron"; expression: string; timezone: string };
  repo?: string;
  repos?: string[];
  labels?: string[];
  on?: AutomationEventRule[];
  routing: { node?: string; agent?: string; model?: string; ephemeral?: boolean };
  safety: {
    approval: ApprovalMode;
    sandbox: SandboxTier;
    maxAttempts: number;
    allowDangerous: boolean;
  };
}

export interface AutomationConfig {
  version: 1;
  automations: AutomationConfigEntry[];
}

export interface AutomationConfigResult {
  ok: boolean;
  config?: AutomationConfig;
  errors: string[];
  warnings: string[];
}

export interface SimulationEvent {
  kind: "github" | "linear" | "schedule" | "webhook" | "manual";
  repo?: string;
  labels?: string[];
  mention?: boolean;
  event?: GithubEventName;
  action?: string;
  conclusion?: string;
  workflow?: string;
}

const GITHUB_EVENTS = new Set<GithubEventName>(["issues", "issue_comment", "pull_request", "pull_request_review_comment", "workflow_run"]);
const TRIGGERS = new Set<AutomationTrigger>(["github", "linear", "schedule", "webhook", "manual"]);
const APPROVALS = new Set<ApprovalMode>(["never", "risky", "always", "autonomous"]);
const SANDBOXES = new Set<SandboxTier>(["read-only", "workspace-write", "danger-full-access"]);
const ID_RE = /^[a-z][a-z0-9-]{1,62}$/;
const ROUTE_RE = /^[A-Za-z0-9._-]+$/;
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function obj(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function strings(value: unknown, at: string, errors: string[], max = 50): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) { errors.push(`${at} must be a list`); return undefined; }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !item.trim()) errors.push(`${at} entries must be non-empty strings`);
    else if (item.length > 120) errors.push(`${at} entries must be at most 120 characters`);
    else out.push(item.trim());
  }
  if (out.length > max) errors.push(`${at} may contain at most ${max} entries`);
  return out;
}

function rejectUnknown(o: Record<string, unknown>, allowed: string[], at: string, errors: string[]) {
  const set = new Set(allowed);
  for (const key of Object.keys(o)) if (!set.has(key)) errors.push(`${at}.${key} is not supported`);
}

function parseRule(value: unknown, at: string, errors: string[]): AutomationEventRule | undefined {
  const o = obj(value);
  if (!o) { errors.push(`${at} must be an object`); return undefined; }
  rejectUnknown(o, ["event", "actions", "labels", "mention", "conclusions", "workflows"], at, errors);
  if (typeof o.event !== "string" || !GITHUB_EVENTS.has(o.event as GithubEventName)) {
    errors.push(`${at}.event must be one of ${[...GITHUB_EVENTS].join(", ")}`);
    return undefined;
  }
  if (o.mention !== undefined && typeof o.mention !== "boolean") errors.push(`${at}.mention must be true or false`);
  return {
    event: o.event as GithubEventName,
    actions: strings(o.actions, `${at}.actions`, errors, 30),
    labels: strings(o.labels, `${at}.labels`, errors, 30),
    mention: typeof o.mention === "boolean" ? o.mention : undefined,
    conclusions: strings(o.conclusions, `${at}.conclusions`, errors, 20),
    workflows: strings(o.workflows, `${at}.workflows`, errors, 30),
  };
}

function parseSchedule(value: unknown, at: string, errors: string[]): AutomationConfigEntry["schedule"] {
  const o = obj(value);
  if (!o) { errors.push(`${at} is required for schedule triggers`); return undefined; }
  rejectUnknown(o, ["cron", "timezone", "at"], at, errors);
  if (typeof o.at === "string") {
    if (o.cron !== undefined || o.timezone !== undefined) errors.push(`${at} cannot combine at with cron/timezone`);
    const date = new Date(o.at);
    if (Number.isNaN(date.getTime())) { errors.push(`${at}.at must be an ISO timestamp`); return undefined; }
    return { kind: "once", at: date.toISOString() };
  }
  if (typeof o.cron !== "string" || !o.cron.trim()) { errors.push(`${at}.cron is required`); return undefined; }
  if (o.cron.trim().split(/\s+/).length !== 5) errors.push(`${at}.cron must have five fields`);
  if (typeof o.timezone !== "string" || !o.timezone.trim()) { errors.push(`${at}.timezone is required`); return undefined; }
  try { new Intl.DateTimeFormat("en-US", { timeZone: o.timezone }).format(); }
  catch { errors.push(`${at}.timezone must be an IANA timezone`); }
  return { kind: "cron", expression: o.cron.trim(), timezone: o.timezone.trim() };
}

function parseEntry(value: unknown, index: number, errors: string[], warnings: string[]): AutomationConfigEntry | undefined {
  const at = `automations[${index}]`;
  const o = obj(value);
  if (!o) { errors.push(`${at} must be an object`); return undefined; }
  rejectUnknown(o, ["id", "name", "enabled", "instructions", "trigger", "schedule", "repo", "repos", "labels", "on", "routing", "safety"], at, errors);

  const id = typeof o.id === "string" ? o.id.trim() : "";
  const name = typeof o.name === "string" ? o.name.trim() : "";
  const instructions = typeof o.instructions === "string" ? o.instructions.trim() : "";
  const trigger = typeof o.trigger === "string" ? o.trigger as AutomationTrigger : undefined;
  if (!ID_RE.test(id)) errors.push(`${at}.id must be a lowercase slug (2-63 characters)`);
  if (!name || name.length > 120) errors.push(`${at}.name is required and must be at most 120 characters`);
  if (!instructions || instructions.length > 16_000) errors.push(`${at}.instructions is required and must be at most 16000 characters`);
  if (!trigger || !TRIGGERS.has(trigger)) errors.push(`${at}.trigger must be one of ${[...TRIGGERS].join(", ")}`);
  if (o.enabled !== undefined && typeof o.enabled !== "boolean") errors.push(`${at}.enabled must be true or false`);

  const repo = typeof o.repo === "string" ? o.repo.trim() : undefined;
  if (repo && (!REPO_RE.test(repo) || repo.includes(".."))) errors.push(`${at}.repo must look like owner/name`);
  const repos = strings(o.repos, `${at}.repos`, errors);
  for (const item of repos ?? []) if (!REPO_RE.test(item) || item.includes("..")) errors.push(`${at}.repos contains invalid repository ${item}`);
  const labels = strings(o.labels, `${at}.labels`, errors, 30);

  let on: AutomationEventRule[] | undefined;
  if (o.on !== undefined) {
    if (!Array.isArray(o.on) || o.on.length === 0) errors.push(`${at}.on must be a non-empty list`);
    else on = o.on.map((rule, i) => parseRule(rule, `${at}.on[${i}]`, errors)).filter((v): v is AutomationEventRule => Boolean(v));
  }
  if (trigger === "github" && !on?.length) warnings.push(`${id || at}: GitHub trigger has no on rules; it will use the default bivy label contract`);
  if (trigger !== "github" && on) errors.push(`${at}.on is only valid for github triggers`);

  const routingRaw = o.routing === undefined ? {} : obj(o.routing);
  if (!routingRaw) errors.push(`${at}.routing must be an object`);
  const routing = routingRaw ?? {};
  rejectUnknown(routing, ["node", "agent", "model", "ephemeral"], `${at}.routing`, errors);
  const node = typeof routing.node === "string" ? routing.node.trim() : undefined;
  if (node && !ROUTE_RE.test(node)) errors.push(`${at}.routing.node contains unsupported characters`);
  if (routing.ephemeral !== undefined && typeof routing.ephemeral !== "boolean") errors.push(`${at}.routing.ephemeral must be true or false`);

  const safetyRaw = o.safety === undefined ? {} : obj(o.safety);
  if (!safetyRaw) errors.push(`${at}.safety must be an object`);
  const safety = safetyRaw ?? {};
  rejectUnknown(safety, ["approval", "sandbox", "maxAttempts", "allowDangerous"], `${at}.safety`, errors);
  const approval = (safety.approval ?? "risky") as ApprovalMode;
  const sandbox = (safety.sandbox ?? "workspace-write") as SandboxTier;
  const maxAttempts = safety.maxAttempts === undefined ? 2 : Number(safety.maxAttempts);
  const allowDangerous = safety.allowDangerous === true;
  if (!APPROVALS.has(approval)) errors.push(`${at}.safety.approval must be one of ${[...APPROVALS].join(", ")}`);
  if (!SANDBOXES.has(sandbox)) errors.push(`${at}.safety.sandbox must be one of ${[...SANDBOXES].join(", ")}`);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) errors.push(`${at}.safety.maxAttempts must be an integer from 1 to 10`);
  if (sandbox === "danger-full-access" && approval === "autonomous" && !allowDangerous) {
    errors.push(`${at} combines autonomous approval with danger-full-access; set safety.allowDangerous: true to acknowledge this explicitly`);
  }
  if (approval === "never") warnings.push(`${id || at}: approval=never still retains Bivy's hard-floor policy, but will not ask before risky actions`);
  if (allowDangerous && !(sandbox === "danger-full-access" && approval === "autonomous")) warnings.push(`${id || at}: allowDangerous has no effect without autonomous + danger-full-access`);

  const schedule = trigger === "schedule" ? parseSchedule(o.schedule, `${at}.schedule`, errors) : undefined;
  if (trigger !== "schedule" && o.schedule !== undefined) errors.push(`${at}.schedule is only valid for schedule triggers`);
  if (trigger === "schedule" && !repo) errors.push(`${at}.repo is required for schedule triggers`);

  if (!id || !name || !instructions || !trigger) return undefined;
  return {
    id, name, enabled: o.enabled !== false, instructions, trigger, schedule, repo, repos, labels, on,
    routing: {
      node,
      agent: typeof routing.agent === "string" ? routing.agent.trim() || undefined : undefined,
      model: typeof routing.model === "string" ? routing.model.trim() || undefined : undefined,
      ephemeral: typeof routing.ephemeral === "boolean" ? routing.ephemeral : undefined,
    },
    safety: { approval, sandbox, maxAttempts, allowDangerous },
  };
}

export function parseAutomationConfig(text: string): AutomationConfigResult {
  let raw: unknown;
  try { raw = parseYaml(text, { uniqueKeys: true }); }
  catch (error) { return { ok: false, errors: [`YAML: ${error instanceof Error ? error.message : String(error)}`], warnings: [] }; }
  const errors: string[] = [];
  const warnings: string[] = [];
  const root = obj(raw);
  if (!root) return { ok: false, errors: ["configuration must be an object"], warnings };
  rejectUnknown(root, ["version", "automations"], "config", errors);
  if (root.version !== 1) errors.push("version must be 1");
  if (!Array.isArray(root.automations)) errors.push("automations must be a list");
  const entries = Array.isArray(root.automations)
    ? root.automations.map((entry, i) => parseEntry(entry, i, errors, warnings)).filter((v): v is AutomationConfigEntry => Boolean(v))
    : [];
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) errors.push(`automation id ${entry.id} is duplicated`);
    ids.add(entry.id);
  }
  return { ok: errors.length === 0, config: errors.length ? undefined : { version: 1, automations: entries }, errors, warnings };
}

/**
 * Explain which automation would fire for a fixture, without running anything.
 * Delegates to the shared evaluator (src/automation) so config-as-code `test`
 * uses the exact same first-match contract as live control-plane intake —
 * see docs/automation-evaluator.md.
 */
export function simulateAutomation(config: AutomationConfig, event: SimulationEvent): { matched?: AutomationConfigEntry; reasons: Array<{ id: string; matched: boolean; reason: string }> } {
  const { matched, trail } = matchFirst(config.automations, event);
  return { matched, reasons: trail };
}

export function parseSimulationEvent(text: string): SimulationEvent {
  const value = parseYaml(text);
  const o = obj(value);
  if (!o) throw new Error("event fixture must be an object");
  const unknown = Object.keys(o).filter((key) => !["kind", "repo", "labels", "mention", "event", "action", "conclusion", "workflow"].includes(key));
  if (unknown.length) throw new Error(`unsupported event fixture field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
  const kind = String(o.kind ?? "") as SimulationEvent["kind"];
  if (!["github", "linear", "schedule", "webhook", "manual"].includes(kind)) throw new Error("event.kind must be github, linear, schedule, webhook, or manual");
  const fixtureErrors: string[] = [];
  const labels = o.labels === undefined ? undefined : strings(o.labels, "event.labels", fixtureErrors, 50);
  if (fixtureErrors.length) throw new Error(fixtureErrors.join("; "));
  if (o.mention !== undefined && typeof o.mention !== "boolean") throw new Error("event.mention must be true or false");
  const repo = typeof o.repo === "string" ? o.repo.trim() : undefined;
  if (repo && (!REPO_RE.test(repo) || repo.includes(".."))) throw new Error("event.repo must look like owner/name");
  const event = o.event === undefined ? undefined : String(o.event) as GithubEventName;
  if (kind === "github" && (!event || !GITHUB_EVENTS.has(event))) throw new Error("GitHub fixtures require a supported event field");
  return {
    kind,
    repo,
    labels,
    mention: o.mention === true,
    event,
    action: typeof o.action === "string" ? o.action : undefined,
    conclusion: typeof o.conclusion === "string" ? o.conclusion : undefined,
    workflow: typeof o.workflow === "string" ? o.workflow : undefined,
  };
}

export const STARTER_AUTOMATION_CONFIG = `# Version-controlled Bivy automations. Commit this file with your repository.\nversion: 1\nautomations:\n  - id: fix-failed-ci\n    name: Fix failed CI\n    enabled: false # review, then enable\n    trigger: github\n    repo: owner/repository\n    instructions: |\n      Investigate the failed CI run, reproduce it locally, make the smallest safe\n      fix, run the affected checks, and open a pull request. Never deploy.\n    on:\n      - event: workflow_run\n        actions: [completed]\n        conclusions: [failure, timed_out, startup_failure]\n    routing:\n      agent: claude-code-sdk\n    safety:\n      approval: risky\n      sandbox: workspace-write\n      maxAttempts: 2\n`;
