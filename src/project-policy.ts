// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
/** Project-owned policy in `<repo>/.bivy/policy.yaml`. */
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { validateRuleset, type Ruleset } from "./policy/ruleset.js";

export const PROJECT_POLICY_PATH = ".bivy/policy.yaml";
export const STARTER_PROJECT_POLICY = `# Repository-owned safety, checks, and retry policy.\nversion: 1\nsafety:\n  maxSandbox: workspace-write\n  approvalFloor: risky\nchecks:\n  scripts: [test, lint, typecheck]\n  timeoutMinutes: 10\n`;
export interface ProjectPolicy {
  version: 1;
  safety?: {
    /** Most permissive sandbox a run may request; the more restrictive side wins. */
    maxSandbox?: "read-only" | "workspace-write" | "danger-full-access";
    /** Minimum approval posture; only restrictive floors are accepted. */
    approvalFloor?: "risky" | "always";
  };
  checks?: { scripts: string[]; timeoutMinutes?: number };
  routing?: { allowedAgents?: string[]; allowedModels?: string[] };
  ruleset?: Ruleset;
}
export interface ProjectPolicyResult { ok: boolean; policy?: ProjectPolicy; errors: string[]; }
const SCRIPT_RE = /^[\w:.-]+$/;

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
export function validateProjectPolicy(value: unknown): ProjectPolicyResult {
  const errors: string[] = [];
  const root = object(value);
  if (!root) return { ok: false, errors: ["policy must be an object"] };
  for (const key of Object.keys(root)) if (!["version", "safety", "checks", "routing", "ruleset"].includes(key)) errors.push(`policy.${key} is not supported`);
  if (root.version !== 1) errors.push("version must be 1");
  let safety: ProjectPolicy["safety"];
  if (root.safety !== undefined) {
    const raw = object(root.safety);
    if (!raw) errors.push("safety must be an object");
    else {
      for (const key of Object.keys(raw)) if (!["maxSandbox", "approvalFloor"].includes(key)) errors.push(`safety.${key} is not supported`);
      const maxSandbox = raw.maxSandbox as "read-only" | "workspace-write" | "danger-full-access" | undefined;
      const approvalFloor = raw.approvalFloor as "risky" | "always" | undefined;
      if (maxSandbox !== undefined && !["read-only", "workspace-write", "danger-full-access"].includes(maxSandbox)) errors.push("safety.maxSandbox is invalid");
      if (approvalFloor !== undefined && !["risky", "always"].includes(approvalFloor)) errors.push("safety.approvalFloor must be risky or always");
      safety = { maxSandbox, approvalFloor };
    }
  }
  let checks: ProjectPolicy["checks"];
  if (root.checks !== undefined) {
    const raw = object(root.checks);
    if (!raw) errors.push("checks must be an object");
    else {
      for (const key of Object.keys(raw)) if (!["scripts", "timeoutMinutes"].includes(key)) errors.push(`checks.${key} is not supported`);
      if (!Array.isArray(raw.scripts) || raw.scripts.length === 0 || raw.scripts.length > 10 || raw.scripts.some((item) => typeof item !== "string")) {
        errors.push("checks.scripts must contain 1-10 string package-script names");
      }
      const scripts = Array.isArray(raw.scripts) && raw.scripts.every((item) => typeof item === "string")
        ? [...new Set(raw.scripts)] as string[]
        : [];
      if (scripts.some((script) => !SCRIPT_RE.test(script))) errors.push("checks.scripts contains an invalid package-script name");
      const timeoutMinutes = raw.timeoutMinutes === undefined ? undefined : Number(raw.timeoutMinutes);
      if (timeoutMinutes !== undefined && (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 30)) errors.push("checks.timeoutMinutes must be an integer from 1 to 30");
      checks = { scripts, timeoutMinutes };
    }
  }
  let routing: ProjectPolicy["routing"];
  if (root.routing !== undefined) {
    const raw = object(root.routing);
    if (!raw) errors.push("routing must be an object");
    else {
      for (const key of Object.keys(raw)) if (!["allowedAgents", "allowedModels"].includes(key)) errors.push(`routing.${key} is not supported`);
      const parseAllowlist = (value: unknown, at: string): string[] | undefined => {
        if (value === undefined) return undefined;
        if (!Array.isArray(value) || value.length === 0 || value.length > 50 || value.some((item) => typeof item !== "string" || !item.trim() || item.length > 300)) {
          errors.push(`${at} must contain 1-50 non-empty strings`);
          return undefined;
        }
        return [...new Set(value.map((item) => item.trim()))];
      };
      routing = { allowedAgents: parseAllowlist(raw.allowedAgents, "routing.allowedAgents"), allowedModels: parseAllowlist(raw.allowedModels, "routing.allowedModels") };
    }
  }
  let ruleset: Ruleset | undefined;
  if (root.ruleset !== undefined) {
    const result = validateRuleset(root.ruleset);
    if (!result.ok || !result.ruleset) errors.push(...result.errors.map((error) => `ruleset${error}`));
    else ruleset = result.ruleset;
  }
  return { ok: errors.length === 0, policy: errors.length ? undefined : { version: 1, safety, checks, routing, ruleset }, errors };
}
export function parseProjectPolicy(text: string): ProjectPolicyResult {
  try { return validateProjectPolicy(parseYaml(text, { uniqueKeys: true })); }
  catch (error) { return { ok: false, errors: [`YAML: ${error instanceof Error ? error.message : String(error)}`] }; }
}
export function findProjectPolicy(start: string): string | undefined {
  let current = path.resolve(start);
  for (;;) {
    const candidate = path.join(current, PROJECT_POLICY_PATH);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}
export function loadProjectPolicy(start: string): ProjectPolicy | undefined {
  const file = findProjectPolicy(start);
  if (!file) return undefined;
  const result = parseProjectPolicy(fs.readFileSync(file, "utf8"));
  if (!result.ok || !result.policy) throw new Error(`Invalid ${file}: ${result.errors.join("; ")}`);
  return result.policy;
}

export function resolveProjectSafety(
  safety: ProjectPolicy["safety"],
  requestedSandbox: "read-only" | "workspace-write" | "danger-full-access",
  requestedApproval: "never" | "risky" | "always" | "autonomous",
): { sandbox: "read-only" | "workspace-write" | "danger-full-access"; approval: "never" | "risky" | "always" | "autonomous" } {
  const sandboxRank = { "read-only": 0, "workspace-write": 1, "danger-full-access": 2 } as const;
  const cap = safety?.maxSandbox;
  const sandbox = cap && sandboxRank[cap] < sandboxRank[requestedSandbox] ? cap : requestedSandbox;
  const approvalRank = { never: 0, autonomous: 0, risky: 1, always: 2 } as const;
  const floor = safety?.approvalFloor;
  const approval = floor && approvalRank[floor] > approvalRank[requestedApproval] ? floor : requestedApproval;
  return { sandbox, approval };
}
