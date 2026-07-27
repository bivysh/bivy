// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
/**
 * Execution policy — a declarative, versioned contract for unattended
 * automation (issue #155). Bivy already has sandbox tiers, approval modes,
 * worktrees, and PR creation; this module is the shared (node + web) type and
 * pure decision logic that turns those knobs into a per-job policy: what
 * runtimes/models a job may use, the sandbox/approval *floor* it cannot be run
 * below, required non-interactive validation commands, and whether a clean
 * commit / pull request is required for the run to count as a success.
 *
 * This file is framework-agnostic (no Node/browser APIs) so it is shared
 * verbatim by the node harness (enforcement — see src/harness/job-policy.ts)
 * and the web UI (the "effective policy" preview). The control plane also
 * imports the type to route/store policy metadata and bounded evidence, but
 * — per the issue's non-goals — never interprets or executes it: the node
 * remains the sole enforcement authority.
 *
 * Every parse function here is deliberately tolerant: an invalid or missing
 * field is dropped and reported in `errors`, never thrown, so a malformed or
 * absent policy degrades to safe defaults (no restriction beyond Bivy's
 * existing behavior) rather than breaking an existing GitHub-queue automation.
 */

export const EXECUTION_POLICY_VERSION = 1;

/** Mirrors `SandboxTier` in src/harness/sandbox.ts — duplicated here (rather
 *  than imported) so this module stays dependency-free and usable from the
 *  browser bundle. Keep the vocabulary in sync with that file. */
export type SandboxTier = "read-only" | "workspace-write" | "danger-full-access";

/** Mirrors `ApprovalMode` in src/guard.ts — see note on SandboxTier above. */
export type ApprovalMode = "never" | "risky" | "always" | "autonomous";

const SANDBOX_TIERS: SandboxTier[] = ["read-only", "workspace-write", "danger-full-access"];
const APPROVAL_MODES: ApprovalMode[] = ["never", "risky", "always", "autonomous"];

/** Stricter = higher rank. A tier "meets the floor" when its rank is >= the
 *  floor's rank. `danger-full-access` is the least restrictive (rank 0);
 *  `read-only` is the most restrictive (rank 2). */
const SANDBOX_RANK: Record<SandboxTier, number> = {
  "danger-full-access": 0,
  "workspace-write": 1,
  "read-only": 2,
};

/** Stricter = higher rank, matching guardToolCall's actual behavior (src/guard.ts):
 *  "never" never asks (rank 0, least restrictive); "autonomous" only pauses for
 *  the backstop set (rank 1); "risky" asks on every write/edit plus risky bash
 *  (rank 2); "always" asks on every bash/write/edit (rank 3, most restrictive). */
const APPROVAL_RANK: Record<ApprovalMode, number> = {
  never: 0,
  autonomous: 1,
  risky: 2,
  always: 3,
};

export function normalizeSandboxTier(value: unknown): SandboxTier | undefined {
  const raw = String(value ?? "").trim().toLowerCase().replace(/_/g, "-");
  return (SANDBOX_TIERS as string[]).includes(raw) ? (raw as SandboxTier) : undefined;
}

export function normalizeApprovalMode(value: unknown): ApprovalMode | undefined {
  const raw = String(value ?? "").trim().toLowerCase();
  return (APPROVAL_MODES as string[]).includes(raw) ? (raw as ApprovalMode) : undefined;
}

/** True if `tier` is at least as restrictive as `floor` (or there is no floor). */
export function sandboxTierMeetsFloor(tier: SandboxTier, floor?: SandboxTier): boolean {
  if (!floor) return true;
  return SANDBOX_RANK[tier] >= SANDBOX_RANK[floor];
}

/** The stricter of the two tiers. Used to clamp a requested/default tier UP to
 *  a policy floor — a run can never lower its configured safety floor. */
export function strictestSandboxTier(a: SandboxTier, b?: SandboxTier): SandboxTier {
  if (!b) return a;
  return SANDBOX_RANK[a] >= SANDBOX_RANK[b] ? a : b;
}

export function approvalModeMeetsFloor(mode: ApprovalMode, floor?: ApprovalMode): boolean {
  if (!floor) return true;
  return APPROVAL_RANK[mode] >= APPROVAL_RANK[floor];
}

export function strictestApprovalMode(a: ApprovalMode, b?: ApprovalMode): ApprovalMode {
  if (!b) return a;
  return APPROVAL_RANK[a] >= APPROVAL_RANK[b] ? a : b;
}

/** A required, non-interactive validation command (e.g. "npm test"). Run by
 *  the node through a governed exec path (timeout + bounded/sanitized output —
 *  see src/harness/job-policy.ts), never central storage of its raw output. */
export interface RequiredCheck {
  /** Stable identifier stored centrally (e.g. "test", "lint"). Never the command text. */
  id: string;
  /** The shell command to run in the job's worktree. */
  command: string;
  /** Per-check timeout; falls back to the enforcer's default when unset. */
  timeoutMs?: number;
}

export interface ChangedFileGlobs {
  /** If set, every changed file must match at least one of these globs. */
  allow?: string[];
  /** If set, no changed file may match any of these globs. Checked before `allow`. */
  deny?: string[];
}

export interface ExecutionPolicy {
  version: number;
  /** Allowed runtime/agent ids (e.g. "claude-code", "codex"). Unset/empty = no restriction. */
  allowedRuntimes?: string[];
  /** Allowed model ids/names. Unset/empty = no restriction. */
  allowedModels?: string[];
  /** The sandbox tier a run may not be launched below. */
  requiredSandboxTier?: SandboxTier;
  /** The approval-mode floor a run may not be launched below. */
  requiredApprovalMode?: ApprovalMode;
  /** Hard wall-clock cap for the whole job, in milliseconds. */
  maxDurationMs?: number;
  /** Allowed "owner/repo" slugs this job may run against. Glob-capable. */
  allowedRepos?: string[];
  /** Allowed target branch names. Glob-capable. */
  allowedBranches?: string[];
  /** Whether the session may reach the network. Defaults to true (current behavior). */
  networkAllowed?: boolean;
  /** Whether MCP servers may be injected into the session. Defaults to true. */
  mcpAllowed?: boolean;
  /** Non-interactive validation commands that must all pass for the run to succeed. */
  requiredChecks?: RequiredCheck[];
  /** Require the worktree to have no uncommitted changes once the run finishes. */
  requireCleanCommit?: boolean;
  /** Require a real (API-verified) pull request for the run to count as success. */
  requirePr?: boolean;
  /** Allow/deny globs the run's changed files must satisfy. */
  changedFiles?: ChangedFileGlobs;
}

/** Fully permissive defaults — no restriction beyond Bivy's existing
 *  behavior. This is what an unconfigured automation (every GitHub-queue job
 *  before #155) gets: absence of a stored policy is safe-by-default, not a
 *  migration step that has to run once. */
export function defaultExecutionPolicy(): ExecutionPolicy {
  return {
    version: EXECUTION_POLICY_VERSION,
    networkAllowed: true,
    mcpAllowed: true,
    requireCleanCommit: false,
    requirePr: false,
  };
}

export interface ParsedExecutionPolicy {
  policy: ExecutionPolicy;
  /** Human-readable problems found while parsing; the returned `policy` has
   *  already dropped/defaulted every field an error mentions. */
  errors: string[];
}

function stringArray(value: unknown, field: string, errors: string[]): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    errors.push(`${field}: expected an array of strings, dropping`);
    return undefined;
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.trim()) out.push(item.trim());
    else errors.push(`${field}: dropped a non-string/empty entry`);
  }
  return out.length ? out : undefined;
}

function optionalBool(value: unknown, field: string, errors: string[]): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    errors.push(`${field}: expected a boolean, dropping`);
    return undefined;
  }
  return value;
}

function optionalPositiveInt(value: unknown, field: string, errors: string[]): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    errors.push(`${field}: expected a positive number, dropping`);
    return undefined;
  }
  return Math.floor(n);
}

function parseRequiredChecks(value: unknown, errors: string[]): RequiredCheck[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    errors.push("requiredChecks: expected an array, dropping");
    return undefined;
  }
  const out: RequiredCheck[] = [];
  for (const [i, raw] of value.entries()) {
    const item = raw as Partial<RequiredCheck> | null | undefined;
    const id = typeof item?.id === "string" ? item.id.trim() : "";
    const command = typeof item?.command === "string" ? item.command.trim() : "";
    if (!id || !command) {
      errors.push(`requiredChecks[${i}]: needs a non-empty id and command, dropping`);
      continue;
    }
    const timeoutMs = optionalPositiveInt(item?.timeoutMs, `requiredChecks[${i}].timeoutMs`, errors);
    out.push({ id, command, ...(timeoutMs ? { timeoutMs } : {}) });
  }
  return out.length ? out : undefined;
}

function parseChangedFiles(value: unknown, errors: string[]): ChangedFileGlobs | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object") {
    errors.push("changedFiles: expected an object, dropping");
    return undefined;
  }
  const obj = value as { allow?: unknown; deny?: unknown };
  const allow = stringArray(obj.allow, "changedFiles.allow", errors);
  const deny = stringArray(obj.deny, "changedFiles.deny", errors);
  return allow || deny ? { ...(allow ? { allow } : {}), ...(deny ? { deny } : {}) } : undefined;
}

/**
 * Parse + validate + normalize an arbitrary (persisted or user-submitted)
 * value into an `ExecutionPolicy`. Always returns a usable policy — on any
 * garbage input this is exactly `defaultExecutionPolicy()` with every problem
 * recorded in `errors` — never throws. Handles the "no version" / legacy shape
 * (nothing stored yet for an existing GitHub-queue automation) by treating it
 * as version 1 with the shipped defaults; there is currently only one schema
 * version, so no field-shape migration is needed yet, but the `version` tag
 * is threaded through so a future breaking change has somewhere to branch on.
 */
export function parseExecutionPolicy(raw: unknown): ParsedExecutionPolicy {
  const errors: string[] = [];
  const base = defaultExecutionPolicy();
  if (raw === undefined || raw === null) return { policy: base, errors };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { policy: base, errors: ["policy: expected an object, using defaults"] };
  }
  const obj = raw as Record<string, unknown>;
  const version = optionalPositiveInt(obj.version, "version", errors) ?? EXECUTION_POLICY_VERSION;
  if (version > EXECUTION_POLICY_VERSION) {
    errors.push(`version ${version} is newer than this build supports (${EXECUTION_POLICY_VERSION}); using defaults`);
    return { policy: base, errors };
  }

  const requiredSandboxTier = obj.requiredSandboxTier !== undefined
    ? normalizeSandboxTier(obj.requiredSandboxTier)
    : undefined;
  if (obj.requiredSandboxTier !== undefined && !requiredSandboxTier) {
    errors.push(`requiredSandboxTier: invalid value ${JSON.stringify(obj.requiredSandboxTier)}, dropping`);
  }
  const requiredApprovalMode = obj.requiredApprovalMode !== undefined
    ? normalizeApprovalMode(obj.requiredApprovalMode)
    : undefined;
  if (obj.requiredApprovalMode !== undefined && !requiredApprovalMode) {
    errors.push(`requiredApprovalMode: invalid value ${JSON.stringify(obj.requiredApprovalMode)}, dropping`);
  }

  const policy: ExecutionPolicy = {
    version: EXECUTION_POLICY_VERSION,
    allowedRuntimes: stringArray(obj.allowedRuntimes, "allowedRuntimes", errors),
    allowedModels: stringArray(obj.allowedModels, "allowedModels", errors),
    requiredSandboxTier,
    requiredApprovalMode,
    maxDurationMs: optionalPositiveInt(obj.maxDurationMs, "maxDurationMs", errors),
    allowedRepos: stringArray(obj.allowedRepos, "allowedRepos", errors),
    allowedBranches: stringArray(obj.allowedBranches, "allowedBranches", errors),
    networkAllowed: optionalBool(obj.networkAllowed, "networkAllowed", errors) ?? base.networkAllowed,
    mcpAllowed: optionalBool(obj.mcpAllowed, "mcpAllowed", errors) ?? base.mcpAllowed,
    requiredChecks: parseRequiredChecks(obj.requiredChecks, errors),
    requireCleanCommit: optionalBool(obj.requireCleanCommit, "requireCleanCommit", errors) ?? base.requireCleanCommit,
    requirePr: optionalBool(obj.requirePr, "requirePr", errors) ?? base.requirePr,
    changedFiles: parseChangedFiles(obj.changedFiles, errors),
  };
  return { policy, errors };
}

/**
 * Merge an override on top of a base policy for an "effective policy" preview
 * — e.g. a per-job override on top of the node's default. Arrays/objects on
 * the patch fully replace the base's (no element-wise append); an explicit
 * `undefined`-free patch field simply isn't present. Pure and side-effect-free
 * so both the node and the web UI compute an identical preview.
 */
export function mergeExecutionPolicy(base: ExecutionPolicy, patch?: Partial<ExecutionPolicy> | null): ExecutionPolicy {
  if (!patch) return base;
  const merged: ExecutionPolicy = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    (merged as unknown as Record<string, unknown>)[key] = value;
  }
  merged.version = base.version;
  return merged;
}

function intersectOrEither(a?: string[], b?: string[]): string[] | undefined {
  if (!a) return b;
  if (!b) return a;
  // Both sides restrict independently — only what's allowed by BOTH survives,
  // same principle as an "AND" of two allowlists. An empty result (no overlap)
  // is intentional: it means nothing satisfies both restrictions.
  const bSet = new Set(b);
  return a.filter((item) => bSet.has(item));
}

function unionDeduped(a?: string[], b?: string[]): string[] | undefined {
  if (!a) return b;
  if (!b) return a;
  return Array.from(new Set([...a, ...b]));
}

/**
 * Combine two INDEPENDENT policy layers (e.g. a node's default floor and a
 * per-`AutomationDefinition` policy) into one that is never weaker than
 * either side — unlike `mergeExecutionPolicy` (a same-layer override for
 * previewing edits, where the patch simply replaces a field), this is for
 * stacking two separately-authored restrictions where a run must satisfy
 * BOTH: a run cannot use `combineExecutionPolicies` to escape either layer's
 * floor. Per-field rule:
 *   - `requiredSandboxTier`/`requiredApprovalMode`: the stricter of the two.
 *   - `maxDurationMs`: the smaller (stricter) of the two, when either is set.
 *   - `networkAllowed`/`mcpAllowed`: false wins (either layer disabling it
 *     disables it overall).
 *   - `requireCleanCommit`/`requirePr`: true wins (either layer requiring it
 *     requires it overall).
 *   - `allowedRuntimes`/`allowedModels`/`allowedRepos`/`allowedBranches`: the
 *     INTERSECTION when both layers restrict it, else whichever one does.
 *   - `requiredChecks`: the union (both layers' checks all run), deduped by id.
 *   - `changedFiles.deny`: the union (either layer's denial applies).
 *   - `changedFiles.allow`: the union of the two allow-lists when both are
 *     set (a pragmatic approximation — true glob-pattern intersection isn't
 *     computed; prefer `deny` on whichever layer needs to actually narrow it).
 */
export function combineExecutionPolicies(a: ExecutionPolicy, b: ExecutionPolicy): ExecutionPolicy {
  const deny = unionDeduped(a.changedFiles?.deny, b.changedFiles?.deny);
  const allow = unionDeduped(a.changedFiles?.allow, b.changedFiles?.allow);
  const checksById = new Map<string, RequiredCheck>();
  for (const check of [...(a.requiredChecks ?? []), ...(b.requiredChecks ?? [])]) {
    if (!checksById.has(check.id)) checksById.set(check.id, check);
  }
  const strictestOrEither = <T,>(strictest: (x: T, y?: T) => T, x?: T, y?: T): T | undefined => {
    if (x === undefined) return y;
    return strictest(x, y);
  };
  return {
    version: EXECUTION_POLICY_VERSION,
    allowedRuntimes: intersectOrEither(a.allowedRuntimes, b.allowedRuntimes),
    allowedModels: intersectOrEither(a.allowedModels, b.allowedModels),
    requiredSandboxTier: strictestOrEither(strictestSandboxTier, a.requiredSandboxTier, b.requiredSandboxTier),
    requiredApprovalMode: strictestOrEither(strictestApprovalMode, a.requiredApprovalMode, b.requiredApprovalMode),
    maxDurationMs: a.maxDurationMs && b.maxDurationMs
      ? Math.min(a.maxDurationMs, b.maxDurationMs)
      : (a.maxDurationMs ?? b.maxDurationMs),
    allowedRepos: intersectOrEither(a.allowedRepos, b.allowedRepos),
    allowedBranches: intersectOrEither(a.allowedBranches, b.allowedBranches),
    networkAllowed: a.networkAllowed === false || b.networkAllowed === false ? false : (a.networkAllowed ?? b.networkAllowed),
    mcpAllowed: a.mcpAllowed === false || b.mcpAllowed === false ? false : (a.mcpAllowed ?? b.mcpAllowed),
    requiredChecks: checksById.size ? Array.from(checksById.values()) : undefined,
    requireCleanCommit: Boolean(a.requireCleanCommit || b.requireCleanCommit),
    requirePr: Boolean(a.requirePr || b.requirePr),
    changedFiles: allow || deny ? { ...(allow ? { allow } : {}), ...(deny ? { deny } : {}) } : undefined,
  };
}

/**
 * Convert a single glob pattern (`*`, `**`, `?`, literal path segments — e.g.
 * `src/**\/*.ts`, `!secrets/**`) into a matcher. Dependency-free (no
 * minimatch/picomatch): the changed-file globs this supports are simple
 * allow/deny path patterns, not a general glob engine.
 */
export function matchGlob(pattern: string, value: string): boolean {
  let re = "";
  const p = pattern.trim();
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === undefined) continue;
    if (c === "*") {
      if (p[i + 1] === "*") {
        re += ".*";
        i++;
        if (p[i + 1] === "/") i++; // "**/x" also matches "x" at the top level
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`).test(value);
}

function matchesAny(patterns: string[], value: string): boolean {
  return patterns.some((pattern) => matchGlob(pattern, value));
}

export interface ChangedFilesEvaluation {
  ok: boolean;
  /** File paths (or repo/branch slugs) that violate the policy, bounded and safe to store centrally. */
  violations: string[];
}

/** Evaluate a list of changed file paths against the policy's allow/deny globs. */
export function evaluateChangedFiles(policy: ExecutionPolicy, changedFiles: string[]): ChangedFilesEvaluation {
  const { allow, deny } = policy.changedFiles ?? {};
  const violations: string[] = [];
  for (const file of changedFiles) {
    if (deny && matchesAny(deny, file)) {
      violations.push(file);
      continue;
    }
    if (allow && !matchesAny(allow, file)) violations.push(file);
  }
  return { ok: violations.length === 0, violations };
}

export function isRuntimeAllowed(policy: ExecutionPolicy, runtimeId: string): boolean {
  return !policy.allowedRuntimes?.length || policy.allowedRuntimes.includes(runtimeId);
}

export function isModelAllowed(policy: ExecutionPolicy, model?: string): boolean {
  if (!policy.allowedModels?.length) return true;
  if (!model) return true; // no model override requested — the runtime's own default applies
  return policy.allowedModels.includes(model);
}

export function isRepoAllowed(policy: ExecutionPolicy, repoSlug: string): boolean {
  return !policy.allowedRepos?.length || matchesAny(policy.allowedRepos, repoSlug);
}

export function isBranchAllowed(policy: ExecutionPolicy, branch: string): boolean {
  return !policy.allowedBranches?.length || matchesAny(policy.allowedBranches, branch);
}

/** The final disposition of a policy-governed run — never a silent success. */
export type PolicyOutcomeStatus = "succeeded" | "failed" | "needs_attention";

/** One required check's bounded, sanitized result — no raw stdout/stderr, no
 *  diffs, no file contents (see src/harness/job-policy.ts, which produces
 *  this). Safe to store centrally. */
export interface CheckEvidence {
  id: string;
  exitCode: number | null;
  durationMs: number;
  ok: boolean;
  timedOut: boolean;
  /** A short, redacted summary (e.g. the last N lines), bounded in length. */
  summary: string;
}

/** The record of a policy-governed run, suitable for central storage: check
 *  identifiers/exit status/duration/bounded summaries, never raw output,
 *  diffs, or file contents. */
export interface PolicyEvidence {
  version: number;
  status: PolicyOutcomeStatus;
  runtimeId?: string;
  model?: string;
  sandboxTier?: SandboxTier;
  approvalMode?: ApprovalMode;
  checks: CheckEvidence[];
  cleanCommit?: boolean;
  pullRequest?: { required: boolean; verified: boolean; url?: string; number?: number };
  changedFiles?: ChangedFilesEvaluation;
  /** High-level, human-readable reasons (never raw command output). */
  violations: string[];
}

/**
 * Aggregate every governance signal into a final status. Failure is layered:
 * a "hard" violation (forbidden runtime/model, a failed/timed-out required
 * check, a changed-file deny/allow violation, an out-of-policy repo/branch)
 * always yields "failed" — the run never gets to claim success. A "soft"
 * violation (no commit when one was required, no verified PR when one was
 * required) yields "needs_attention": the work may still be salvageable by a
 * human, so it is distinguished from an outright policy breach, but it is
 * still never reported as a successful run.
 */
export function evaluatePolicyOutcome(input: {
  hardViolations: string[];
  softViolations: string[];
}): PolicyOutcomeStatus {
  if (input.hardViolations.length > 0) return "failed";
  if (input.softViolations.length > 0) return "needs_attention";
  return "succeeded";
}
