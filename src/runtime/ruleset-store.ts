// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
// Bivy's app-owned ruleset registry — the source of truth for user-authored
// run-orchestration policy (docs/rulesets.md).
//
// A ruleset decides what happens when a run fails: retry, reroute through a
// fallback chain, or park for a human. The schema + pure matcher live in
// src/policy/ruleset.ts; this module is only the STORAGE seam. It mirrors
// local-model-store.ts: a small JSON file under the app dir, non-secret config
// only, validated with the policy's own `validateRuleset` before it can steer a
// live run. It is deliberately node-local (policy is per-machine), not synced
// through the credential envelope.
//
// One ruleset may be marked ACTIVE — that's the one the work-queue effector
// consults (see server.ts activeQueueRuleset). When none is active, the queue
// falls back to the built-in DEFAULT_RULESET.

import fs from "node:fs";
import path from "node:path";
import { validateRuleset, type Ruleset, type RuleContext } from "../policy/ruleset.js";

/** The on-disk shape: a name→ruleset map plus which one is active. */
export interface RulesetsFile {
  /** Name of the ruleset the work queue should use, or null for the built-in default. */
  activeName: string | null;
  rulesets: Record<string, Ruleset>;
}

/** A ruleset plus its derived `active` flag — what the UI enumerates/edits. */
export type RulesetInfo = Ruleset & { active: boolean };

const FILE_NAME = "rulesets.json";

function configPath(dir: string): string {
  return path.join(dir, FILE_NAME);
}

export function loadRulesets(dir: string): RulesetsFile {
  const file = configPath(dir);
  if (!fs.existsSync(file)) return { activeName: null, rulesets: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object") return { activeName: null, rulesets: {} };
    const rawRulesets = (parsed as any).rulesets;
    const rulesets: Record<string, Ruleset> = {};
    if (rawRulesets && typeof rawRulesets === "object") {
      for (const spec of Object.values(rawRulesets)) {
        // Re-validate on read: a hand-edited or partially-migrated file never
        // yields a shape the matcher can't trust. Invalid entries are dropped.
        const result = validateRuleset(spec);
        if (result.ok && result.ruleset) rulesets[result.ruleset.name] = result.ruleset;
      }
    }
    const activeRaw = (parsed as any).activeName;
    const activeName = typeof activeRaw === "string" && rulesets[activeRaw] ? activeRaw : null;
    return { activeName, rulesets };
  } catch {
    return { activeName: null, rulesets: {} };
  }
}

export function saveRulesets(dir: string, file: RulesetsFile): void {
  fs.mkdirSync(dir, { recursive: true });
  const safe: RulesetsFile = {
    activeName: file.activeName && file.rulesets[file.activeName] ? file.activeName : null,
    rulesets: file.rulesets || {},
  };
  const target = configPath(dir);
  fs.writeFileSync(target, `${JSON.stringify(safe, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(target, 0o600);
  } catch {
    /* best effort */
  }
}

/** Full rulesets + active flag, for the UI. Sorted by name (active first). */
export function listRulesetInfos(dir: string): RulesetInfo[] {
  const { activeName, rulesets } = loadRulesets(dir);
  return Object.values(rulesets)
    .map((r) => ({ ...r, active: r.name === activeName }))
    .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
}

/**
 * Validate and store a ruleset (insert or update, keyed by name). Pass
 * `active: true` to make it the queue's active ruleset, `false` to clear the
 * active flag if this ruleset currently holds it, or omit to leave it unchanged.
 * Throws with a human-readable message when the input fails validation.
 */
export function upsertRuleset(dir: string, input: unknown, active?: boolean): { name: string } {
  const result = validateRuleset(input);
  if (!result.ok || !result.ruleset) {
    throw new Error(`Invalid ruleset: ${result.errors.join("; ") || "did not match the expected shape"}`);
  }
  const ruleset = result.ruleset;
  const file = loadRulesets(dir);
  file.rulesets[ruleset.name] = ruleset;
  if (active === true) file.activeName = ruleset.name;
  else if (active === false && file.activeName === ruleset.name) file.activeName = null;
  saveRulesets(dir, file);
  return { name: ruleset.name };
}

export function removeRuleset(dir: string, name: string): void {
  const file = loadRulesets(dir);
  const key = String(name ?? "").trim();
  if (!key) throw new Error("ruleset name required");
  delete file.rulesets[key];
  if (file.activeName === key) file.activeName = null;
  saveRulesets(dir, file);
}

/**
 * The active ruleset, but only if it `appliesTo` the given context — the
 * work-queue effector calls this so an authored session-only ruleset never
 * silently steers unattended queue runs. Undefined means "use the default".
 */
export function activeRulesetFor(dir: string, context: RuleContext): Ruleset | undefined {
  const { activeName, rulesets } = loadRulesets(dir);
  if (!activeName) return undefined;
  const ruleset = rulesets[activeName];
  if (!ruleset || !ruleset.appliesTo.includes(context)) return undefined;
  return ruleset;
}
