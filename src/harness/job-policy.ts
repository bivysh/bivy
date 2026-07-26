// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
/**
 * Job execution policy — node-side enforcement (issue #155).
 *
 * The shared, framework-agnostic policy type and pure decision logic live in
 * `@bivy/core/execution-policy` (used by both the node and the web "effective
 * policy" preview). This module is the node's enforcement authority: it is the
 * ONLY place that actually runs required-check commands, inspects the
 * worktree, and decides whether a governed run gets to report success. The
 * control plane only ever routes/stores the resulting `PolicyEvidence` — it
 * never re-derives or overrides the outcome.
 *
 * Two enforcement shapes:
 *   - "asserts", called BEFORE a session starts (runtime/model/repo/branch
 *     allowlists) — these throw `PolicyViolationError` so a disallowed run
 *     never starts, including a runtime-host FALLBACK target (resolve first,
 *     assert on the resolved id — never the originally-requested one).
 *   - "resolve*Floor" helpers that clamp a requested sandbox tier / approval
 *     mode UP to the policy's floor — a run can request looser settings, but
 *     the effective value used is always at least as strict as the policy
 *     requires. There is deliberately no "loosen" direction: nothing here
 *     reads an agent-supplied override, so a running session cannot relax its
 *     own policy from inside the turn.
 *   - post-run verification (required checks, clean commit, changed files, a
 *     verified PR) plus `buildPolicyEvidence`, which aggregates every signal
 *     into a bounded, sanitized `PolicyEvidence` — the only thing safe to hand
 *     to central storage.
 */
import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  EXECUTION_POLICY_VERSION,
  evaluatePolicyOutcome,
  isBranchAllowed,
  isModelAllowed,
  isRepoAllowed,
  isRuntimeAllowed,
  strictestApprovalMode,
  strictestSandboxTier,
  type ApprovalMode,
  type ChangedFilesEvaluation,
  type CheckEvidence,
  type ExecutionPolicy,
  type PolicyEvidence,
  type RequiredCheck,
  type SandboxTier,
} from "@bivy/core/execution-policy";
import { redactSecrets } from "../redact.js";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export class PolicyViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyViolationError";
  }
}

// --- Pre-run allowlist gates ------------------------------------------------

export function assertRuntimeAllowed(policy: ExecutionPolicy, runtimeId: string): void {
  if (!isRuntimeAllowed(policy, runtimeId)) {
    throw new PolicyViolationError(`runtime "${runtimeId}" is not in this job's allowed runtimes`);
  }
}

export function assertModelAllowed(policy: ExecutionPolicy, model: string | undefined): void {
  if (!isModelAllowed(policy, model)) {
    throw new PolicyViolationError(`model "${model}" is not in this job's allowed models`);
  }
}

export function assertRepoAllowed(policy: ExecutionPolicy, repoSlug: string): void {
  if (!isRepoAllowed(policy, repoSlug)) {
    throw new PolicyViolationError(`repo "${repoSlug}" is not in this job's allowed repos`);
  }
}

export function assertBranchAllowed(policy: ExecutionPolicy, branch: string): void {
  if (!isBranchAllowed(policy, branch)) {
    throw new PolicyViolationError(`branch "${branch}" is not in this job's allowed branches`);
  }
}

// --- Floor resolution (clamp UP only — never relax) -------------------------

/** The sandbox tier to actually launch at: at least as strict as the policy's
 *  floor, regardless of what was requested. */
export function resolveEffectiveSandboxTier(policy: ExecutionPolicy, requested: SandboxTier): SandboxTier {
  return strictestSandboxTier(requested, policy.requiredSandboxTier);
}

/** The approval mode to actually guard tool calls with: at least as strict as
 *  the policy's floor, regardless of the node's current global setting. */
export function resolveEffectiveApprovalMode(policy: ExecutionPolicy, requested: ApprovalMode): ApprovalMode {
  return strictestApprovalMode(requested, policy.requiredApprovalMode);
}

// --- Governed required-check execution --------------------------------------

const DEFAULT_CHECK_TIMEOUT_MS = 5 * 60_000;
/** Central storage gets a bounded, sanitized tail of the output — never the
 *  full raw stdout/stderr, diffs, or file contents (issue #155 non-goal). */
const MAX_SUMMARY_CHARS = 4000;

function boundedSummary(stdout: unknown, stderr: unknown): string {
  const combined = [String(stdout ?? "").trim(), String(stderr ?? "").trim()].filter(Boolean).join("\n--- stderr ---\n");
  const redacted = redactSecrets(combined);
  if (redacted.length <= MAX_SUMMARY_CHARS) return redacted;
  return `[truncated — showing the last ${MAX_SUMMARY_CHARS} characters]\n${redacted.slice(-MAX_SUMMARY_CHARS)}`;
}

/**
 * Run one required check non-interactively, with a hard timeout and bounded,
 * redacted output capture. This is the ONLY governed path that runs a
 * validation command; it never streams output anywhere, and the returned
 * `CheckEvidence` is exactly what is safe to persist centrally.
 */
export async function runRequiredCheck(check: RequiredCheck, cwd: string): Promise<CheckEvidence> {
  const timeoutMs = check.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  const startedAt = Date.now();
  try {
    const { stdout, stderr } = await execAsync(check.command, {
      cwd,
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 16 * 1024 * 1024,
    });
    return {
      id: check.id,
      exitCode: 0,
      durationMs: Date.now() - startedAt,
      ok: true,
      timedOut: false,
      summary: boundedSummary(stdout, stderr),
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: unknown; stderr?: unknown; code?: unknown; killed?: boolean };
    const durationMs = Date.now() - startedAt;
    const timedOut = Boolean(err.killed);
    const exitCode = typeof err.code === "number" ? err.code : null;
    const summary = boundedSummary(err.stdout, err.stderr ?? err.message);
    return {
      id: check.id,
      exitCode,
      durationMs,
      ok: false,
      timedOut,
      summary: timedOut ? `${summary}\n[timed out after ${timeoutMs}ms]` : summary,
    };
  }
}

/** Run every required check in sequence (checks may share a worktree/build
 *  cache, so they don't run concurrently) and return all their evidence. */
export async function runRequiredChecks(checks: RequiredCheck[] | undefined, cwd: string): Promise<CheckEvidence[]> {
  const results: CheckEvidence[] = [];
  for (const check of checks ?? []) {
    results.push(await runRequiredCheck(check, cwd));
  }
  return results;
}

// --- Worktree / PR verification ---------------------------------------------

/** True when the worktree has no uncommitted changes (the safety-net commit
 *  the issue-automation flow already takes should have made this true). */
export async function isWorktreeClean(cwd: string): Promise<boolean> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, "status", "--porcelain"]);
  return !stdout.trim();
}

/** Paths changed on the current branch relative to `base`, via `git diff
 *  --name-only base...HEAD` (merge-base diff, so it's just this branch's own
 *  changes). Never the diff content itself — only filenames leave this call. */
export async function listChangedFiles(cwd: string, base: string): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, "diff", "--name-only", `${base}...HEAD`]);
  return stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

export interface PrLike {
  url?: string;
  number?: number;
  state?: string;
}

export interface PullRequestVerification {
  required: boolean;
  verified: boolean;
  url?: string;
  number?: number;
}

/**
 * Whether a "PR required" policy is satisfied. `pr` must be a reference the
 * caller already verified against the GitHub API (e.g.
 * `maybeDetectPullRequest`'s `record.prs`) — never trust an agent's own claim
 * that it opened a PR; a URL/number with no matching API-confirmed PrRef does
 * not count.
 */
export function verifyPullRequest(policy: ExecutionPolicy, pr: PrLike | undefined): PullRequestVerification {
  const required = Boolean(policy.requirePr);
  const verified = !required || Boolean(pr?.url && typeof pr.number === "number");
  return { required, verified, url: pr?.url, number: pr?.number };
}

// --- Evidence aggregation ----------------------------------------------------

export interface PolicyEvaluationInput {
  policy: ExecutionPolicy;
  runtimeId?: string;
  model?: string;
  sandboxTier?: SandboxTier;
  approvalMode?: ApprovalMode;
  checks: CheckEvidence[];
  cleanCommit: boolean;
  pullRequest: PullRequestVerification;
  changedFiles: ChangedFilesEvaluation;
  /** Extra hard violations discovered before the run started (e.g. a
   *  repo/branch mismatch caught before a worktree even existed). */
  extraHardViolations?: string[];
}

/**
 * Aggregate every post-run governance signal into one `PolicyEvidence`
 * record. A failed/timed-out required check or a changed-file glob violation
 * is a hard failure (the run is blocked from claiming success outright); a
 * missing commit or missing PR when required is a soft "needs_attention" —
 * recoverable, but never reported as a plain success either. This is the
 * single function that decides "succeeded" vs "failed" vs "needs_attention";
 * nothing upstream may override it into a false success.
 */
export function buildPolicyEvidence(input: PolicyEvaluationInput): PolicyEvidence {
  const hardViolations: string[] = [...(input.extraHardViolations ?? [])];
  const softViolations: string[] = [];

  for (const check of input.checks) {
    if (check.ok) continue;
    hardViolations.push(
      check.timedOut
        ? `required check "${check.id}" timed out`
        : `required check "${check.id}" failed (exit ${check.exitCode ?? "unknown"})`,
    );
  }
  if (!input.changedFiles.ok) {
    hardViolations.push(`changed files violate this job's policy globs: ${input.changedFiles.violations.join(", ")}`);
  }
  if (input.policy.requireCleanCommit && !input.cleanCommit) {
    softViolations.push("the worktree still has uncommitted changes after the run");
  }
  if (input.pullRequest.required && !input.pullRequest.verified) {
    softViolations.push("this job requires a pull request, and none was verified");
  }

  const status = evaluatePolicyOutcome({ hardViolations, softViolations });
  return {
    version: EXECUTION_POLICY_VERSION,
    status,
    runtimeId: input.runtimeId,
    model: input.model,
    sandboxTier: input.sandboxTier,
    approvalMode: input.approvalMode,
    checks: input.checks,
    cleanCommit: input.cleanCommit,
    pullRequest: input.pullRequest,
    changedFiles: input.changedFiles,
    violations: [...hardViolations, ...softViolations],
  };
}
