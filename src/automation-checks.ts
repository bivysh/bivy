// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

export interface AutomationCheckResult {
  name: string;
  commandHash: string;
  status: "passed" | "failed" | "skipped";
  exitCode?: number;
  durationMs: number;
}

const DEFAULT_SCRIPT_NAMES = ["test", "lint", "typecheck"];
const DEFAULT_CHECK_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_CHECK_TIMEOUT_MS = 30 * 60 * 1000;

function configuredScriptNames(env: NodeJS.ProcessEnv): string[] {
  const raw = env.BIVY_AUTOMATION_CHECKS?.trim();
  if (!raw) return DEFAULT_SCRIPT_NAMES;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return [...new Set(parsed.map(String).map((s) => s.trim()).filter((s) => /^[\w:.-]+$/.test(s)))].slice(0, 10);
  } catch {
    // Fall through to a comma list; malformed entries are discarded rather than
    // interpreted as shell. Only package-script names are accepted.
  }
  return [...new Set(raw.split(",").map((s) => s.trim()).filter((s) => /^[\w:.-]+$/.test(s)))].slice(0, 10);
}

function checkTimeoutMs(env: NodeJS.ProcessEnv): number {
  const parsed = Number(env.BIVY_AUTOMATION_CHECK_TIMEOUT_MS);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_CHECK_TIMEOUT_MS;
  return Math.min(MAX_CHECK_TIMEOUT_MS, Math.max(1_000, Math.floor(parsed)));
}

function packageManager(cwd: string): { command: string; args: (script: string) => string[] } {
  if (fs.existsSync(path.join(cwd, "pnpm-lock.yaml"))) return { command: "pnpm", args: (script) => ["run", script] };
  if (fs.existsSync(path.join(cwd, "yarn.lock"))) return { command: "yarn", args: (script) => ["run", script] };
  return { command: "npm", args: (script) => ["run", script] };
}

/** Discover and run only declared package scripts. Command text and output stay
 * on the node; hosted evidence receives a name, hash, pass/fail, and exit code. */
export function runRequiredAutomationChecks(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  run: typeof spawnSync = spawnSync,
): AutomationCheckResult[] {
  let pkg: { scripts?: Record<string, unknown> };
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
  } catch {
    return [];
  }
  const manager = packageManager(cwd);
  const timeout = checkTimeoutMs(env);
  const results: AutomationCheckResult[] = [];
  for (const name of configuredScriptNames(env)) {
    if (typeof pkg.scripts?.[name] !== "string") continue;
    const args = manager.args(name);
    const commandHash = `sha256:${createHash("sha256").update(JSON.stringify([manager.command, ...args])).digest("hex")}`;
    const startedAt = Date.now();
    const result = run(manager.command, args, {
      cwd,
      env,
      stdio: "ignore",
      timeout,
      killSignal: "SIGTERM",
    });
    const exitCode = typeof result.status === "number" ? result.status : 1;
    results.push({ name, commandHash, status: exitCode === 0 ? "passed" : "failed", exitCode, durationMs: Math.max(0, Date.now() - startedAt) });
  }
  return results;
}
