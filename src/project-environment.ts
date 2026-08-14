// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
/**
 * Repository-owned environment manifest in `<repo>/.bivy/environment.yaml`.
 *
 * This file declares what a repository NEEDS to run well — required/preferred
 * Machine capability tags, and named services with a health-check/start
 * script — it never GRANTS permissions and never carries secrets. `.bivy/policy.yaml`
 * (see project-policy.ts) stays the file that governs what a run is allowed to
 * do; this one only describes environment requirements.
 *
 * A `script` field is a package-script NAME (identical shape/constraint to
 * `.bivy/policy.yaml`'s `checks.scripts`), never raw shell — running it goes
 * through the same governed, sandboxed, policy-gated exec path checks already
 * use. Loading/validating this file NEVER executes anything: parsing is pure,
 * and a script only runs when something explicitly invokes it as a policy-gated
 * action (e.g. a preflight check), not merely because the manifest was found.
 */
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

export const PROJECT_ENVIRONMENT_PATH = ".bivy/environment.yaml";
export const STARTER_PROJECT_ENVIRONMENT = `# Repository-owned environment requirements. Declares needs, not permissions.\nversion: 1\ncapabilities:\n  required: []\n  preferred: []\nservices: {}\n`;

// Kept identical to @bivy/core's capability-routing.ts CAPABILITY_TAG_RE.
const CAPABILITY_TAG_RE = /^[a-z][a-z0-9-]{0,63}$/;
const SCRIPT_RE = /^[\w:.-]+$/;
const SERVICE_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_TAGS = 32;
const MAX_SERVICES = 10;

export interface ProjectEnvironmentServiceStep {
  script: string;
  timeoutMinutes?: number;
}
export interface ProjectEnvironmentService {
  healthCheck?: ProjectEnvironmentServiceStep;
  start?: ProjectEnvironmentServiceStep;
}
export interface ProjectEnvironment {
  version: 1;
  capabilities?: { required?: string[]; preferred?: string[] };
  services?: Record<string, ProjectEnvironmentService>;
}
export interface ProjectEnvironmentResult { ok: boolean; environment?: ProjectEnvironment; errors: string[]; }

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function tagList(value: unknown, at: string, errors: string[]): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) { errors.push(`${at} must be a list of lowercase capability tags`); return undefined; }
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string" || !CAPABILITY_TAG_RE.test(raw)) errors.push(`${at} entries must be lowercase slugs (letters, digits, '-'; up to 64 characters)`);
    else if (!out.includes(raw)) out.push(raw);
  }
  if (out.length > MAX_TAGS) errors.push(`${at} may contain at most ${MAX_TAGS} tags`);
  return out;
}

function serviceStep(value: unknown, at: string, errors: string[]): ProjectEnvironmentServiceStep | undefined {
  if (value === undefined) return undefined;
  const raw = object(value);
  if (!raw) { errors.push(`${at} must be an object`); return undefined; }
  for (const key of Object.keys(raw)) if (!["script", "timeoutMinutes"].includes(key)) errors.push(`${at}.${key} is not supported`);
  const script = typeof raw.script === "string" ? raw.script : undefined;
  if (!script || !SCRIPT_RE.test(script)) { errors.push(`${at}.script must be a package-script name (letters, numbers, _, :, ., -)`); return undefined; }
  const timeoutMinutes = raw.timeoutMinutes === undefined ? undefined : Number(raw.timeoutMinutes);
  if (timeoutMinutes !== undefined && (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 30)) {
    errors.push(`${at}.timeoutMinutes must be an integer from 1 to 30`);
    return { script };
  }
  return { script, timeoutMinutes };
}

export function validateProjectEnvironment(value: unknown): ProjectEnvironmentResult {
  const errors: string[] = [];
  const root = object(value);
  if (!root) return { ok: false, errors: ["environment must be an object"] };
  for (const key of Object.keys(root)) if (!["version", "capabilities", "services"].includes(key)) errors.push(`environment.${key} is not supported`);
  if (root.version !== 1) errors.push("version must be 1");

  let capabilities: ProjectEnvironment["capabilities"];
  if (root.capabilities !== undefined) {
    const raw = object(root.capabilities);
    if (!raw) errors.push("capabilities must be an object");
    else {
      for (const key of Object.keys(raw)) if (!["required", "preferred"].includes(key)) errors.push(`capabilities.${key} is not supported`);
      capabilities = {
        required: tagList(raw.required, "capabilities.required", errors),
        preferred: tagList(raw.preferred, "capabilities.preferred", errors),
      };
    }
  }

  let services: ProjectEnvironment["services"];
  if (root.services !== undefined) {
    const raw = object(root.services);
    if (!raw) errors.push("services must be an object");
    else {
      const names = Object.keys(raw);
      if (names.length > MAX_SERVICES) errors.push(`services may contain at most ${MAX_SERVICES} entries`);
      services = {};
      for (const name of names) {
        const at = `services.${name}`;
        if (!SERVICE_NAME_RE.test(name)) { errors.push(`${at} must use a lowercase slug name`); continue; }
        const spec = object(raw[name]);
        if (!spec) { errors.push(`${at} must be an object`); continue; }
        for (const key of Object.keys(spec)) if (!["healthCheck", "start"].includes(key)) errors.push(`${at}.${key} is not supported`);
        services[name] = {
          healthCheck: serviceStep(spec.healthCheck, `${at}.healthCheck`, errors),
          start: serviceStep(spec.start, `${at}.start`, errors),
        };
      }
    }
  }

  const environment: ProjectEnvironment = { version: 1, capabilities, services };
  return { ok: errors.length === 0, environment: errors.length ? undefined : environment, errors };
}

export function parseProjectEnvironment(text: string): ProjectEnvironmentResult {
  try { return validateProjectEnvironment(parseYaml(text, { uniqueKeys: true })); }
  catch (error) { return { ok: false, errors: [`YAML: ${error instanceof Error ? error.message : String(error)}`] }; }
}

export function findProjectEnvironment(start: string): string | undefined {
  let current = path.resolve(start);
  for (;;) {
    const candidate = path.join(current, PROJECT_ENVIRONMENT_PATH);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function loadProjectEnvironment(start: string): ProjectEnvironment | undefined {
  const file = findProjectEnvironment(start);
  if (!file) return undefined;
  const result = parseProjectEnvironment(fs.readFileSync(file, "utf8"));
  if (!result.ok || !result.environment) throw new Error(`Invalid ${file}: ${result.errors.join("; ")}`);
  return result.environment;
}
