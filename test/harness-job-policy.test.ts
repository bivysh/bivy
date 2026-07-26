import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultExecutionPolicy, type ExecutionPolicy } from "@bivy/core/execution-policy";
import {
  PolicyViolationError,
  assertBranchAllowed,
  assertModelAllowed,
  assertRepoAllowed,
  assertRuntimeAllowed,
  buildPolicyEvidence,
  isWorktreeClean,
  listChangedFiles,
  resolveEffectiveApprovalMode,
  resolveEffectiveSandboxTier,
  runRequiredChecks,
  verifyPullRequest,
} from "../src/harness/job-policy.js";

let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${(error as Error).stack ?? (error as Error).message}`);
  }
}

function git(dir: string, ...args: string[]) {
  execFileSync("git", ["-C", dir, ...args], {
    stdio: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "t@t.local",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "t@t.local",
    },
  });
}

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-job-policy-"));
  git(dir, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "initial");
  git(dir, "checkout", "-q", "-b", "work");
  return dir;
}

function policyWith(patch: Partial<ExecutionPolicy>): ExecutionPolicy {
  return { ...defaultExecutionPolicy(), ...patch };
}

async function main() {
  // --- forbidden runtime / model ---------------------------------------
  await check("assertRuntimeAllowed throws for a runtime outside the allowlist", () => {
    const policy = policyWith({ allowedRuntimes: ["codex"] });
    assert.throws(() => assertRuntimeAllowed(policy, "claude-code"), PolicyViolationError);
    assert.doesNotThrow(() => assertRuntimeAllowed(policy, "codex"));
    return Promise.resolve();
  });

  await check("assertRuntimeAllowed is a no-op with no allowlist configured", () => {
    assert.doesNotThrow(() => assertRuntimeAllowed(defaultExecutionPolicy(), "anything"));
    return Promise.resolve();
  });

  await check("assertModelAllowed throws for a model outside the allowlist", () => {
    const policy = policyWith({ allowedModels: ["claude-sonnet-4-5"] });
    assert.throws(() => assertModelAllowed(policy, "gpt-5"), PolicyViolationError);
    assert.doesNotThrow(() => assertModelAllowed(policy, "claude-sonnet-4-5"));
    // No model requested at all (runtime default applies) — never a forbidden fallback.
    assert.doesNotThrow(() => assertModelAllowed(policy, undefined));
    return Promise.resolve();
  });

  // --- repo/branch constraints (also covers "fallback must remain in the allowlist") ---
  await check("assertRepoAllowed/assertBranchAllowed enforce glob-capable allowlists", () => {
    const policy = policyWith({ allowedRepos: ["bivysh/*"], allowedBranches: ["bivy/issue-*"] });
    assert.doesNotThrow(() => assertRepoAllowed(policy, "bivysh/bivy"));
    assert.throws(() => assertRepoAllowed(policy, "other/repo"), PolicyViolationError);
    assert.doesNotThrow(() => assertBranchAllowed(policy, "bivy/issue-155"));
    assert.throws(() => assertBranchAllowed(policy, "main"), PolicyViolationError);
    return Promise.resolve();
  });

  // --- sandbox downgrade ------------------------------------------------
  await check("resolveEffectiveSandboxTier clamps a weaker request UP to the policy floor", () => {
    const policy = policyWith({ requiredSandboxTier: "read-only" });
    assert.equal(resolveEffectiveSandboxTier(policy, "danger-full-access"), "read-only");
    assert.equal(resolveEffectiveSandboxTier(policy, "workspace-write"), "read-only");
    // A request stricter than the floor is left alone — the floor is a minimum, not a pin.
    assert.equal(resolveEffectiveSandboxTier(policy, "read-only"), "read-only");
    return Promise.resolve();
  });

  await check("resolveEffectiveSandboxTier is a no-op with no floor configured", () => {
    assert.equal(resolveEffectiveSandboxTier(defaultExecutionPolicy(), "danger-full-access"), "danger-full-access");
    return Promise.resolve();
  });

  // --- approval-mode downgrade -------------------------------------------
  await check("resolveEffectiveApprovalMode clamps a weaker request UP to the policy floor", () => {
    const policy = policyWith({ requiredApprovalMode: "always" });
    assert.equal(resolveEffectiveApprovalMode(policy, "never"), "always");
    assert.equal(resolveEffectiveApprovalMode(policy, "autonomous"), "always");
    return Promise.resolve();
  });

  // --- governed required-check execution: pass / fail / timeout ----------
  await check("runRequiredChecks reports ok=true for a passing command", async () => {
    const [result] = await runRequiredChecks([{ id: "ok-check", command: "echo hi" }], os.tmpdir());
    assert.equal(result.id, "ok-check");
    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.match(result.summary, /hi/);
  });

  await check("runRequiredChecks reports ok=false with the exit code for a failing command", async () => {
    const [result] = await runRequiredChecks([{ id: "fail-check", command: "exit 3" }], os.tmpdir());
    assert.equal(result.ok, false);
    assert.equal(result.timedOut, false);
    assert.equal(result.exitCode, 3);
  });

  await check("runRequiredChecks times out a long-running command and reports timedOut", async () => {
    const [result] = await runRequiredChecks(
      [{ id: "slow-check", command: "sleep 5", timeoutMs: 200 }],
      os.tmpdir(),
    );
    assert.equal(result.ok, false);
    assert.equal(result.timedOut, true);
    assert.match(result.summary, /timed out/);
  });

  await check("check output is bounded and secrets are redacted before it leaves this module", async () => {
    const long = "x".repeat(10_000);
    const [result] = await runRequiredChecks(
      [{ id: "bounded-check", command: `printf '%s ghp_${"a".repeat(36)} %s' "${long}" done` }],
      os.tmpdir(),
    );
    assert.ok(result.summary.length < 4_500, `summary should be bounded, got ${result.summary.length} chars`);
    assert.ok(!result.summary.includes("ghp_"), "a GitHub token must be redacted out of the stored summary");
  });

  // --- missing commit -----------------------------------------------------
  await check("isWorktreeClean is false with uncommitted changes, true once committed", async () => {
    const dir = makeRepo();
    assert.equal(await isWorktreeClean(dir), true);
    fs.writeFileSync(path.join(dir, "b.txt"), "dirty\n");
    assert.equal(await isWorktreeClean(dir), false);
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "second");
    assert.equal(await isWorktreeClean(dir), true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // --- changed-file violations (via listChangedFiles + core's evaluateChangedFiles) ---
  await check("listChangedFiles + evaluateChangedFiles catch a denied file on the branch", async () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, "secrets.env"), "TOKEN=x\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "add secrets");
    const changed = await listChangedFiles(dir, "main");
    assert.deepEqual(changed.sort(), ["secrets.env"]);

    const { evaluateChangedFiles } = await import("@bivy/core/execution-policy");
    const policy = policyWith({ changedFiles: { deny: ["**/*.env"] } });
    const evaluation = evaluateChangedFiles(policy, changed);
    assert.equal(evaluation.ok, false);
    assert.deepEqual(evaluation.violations, ["secrets.env"]);

    const evidence = buildPolicyEvidence({
      policy,
      checks: [],
      cleanCommit: true,
      pullRequest: verifyPullRequest(policy, undefined),
      changedFiles: evaluation,
    });
    assert.equal(evidence.status, "failed");
    assert.ok(evidence.violations.some((v) => v.includes("secrets.env")));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // --- missing PR -----------------------------------------------------------
  await check("verifyPullRequest requires a verified url+number when the policy demands a PR", () => {
    const policy = policyWith({ requirePr: true });
    const missing = verifyPullRequest(policy, undefined);
    assert.equal(missing.required, true);
    assert.equal(missing.verified, false);

    const present = verifyPullRequest(policy, { url: "https://github.com/o/r/pull/1", number: 1, state: "open" });
    assert.equal(present.verified, true);

    // Not required at all — trivially satisfied.
    assert.equal(verifyPullRequest(defaultExecutionPolicy(), undefined).verified, true);
    return Promise.resolve();
  });

  await check("buildPolicyEvidence: a missing required PR is needs_attention, never a false success", () => {
    const policy = policyWith({ requirePr: true });
    const evidence = buildPolicyEvidence({
      policy,
      checks: [],
      cleanCommit: true,
      pullRequest: verifyPullRequest(policy, undefined),
      changedFiles: { ok: true, violations: [] },
    });
    assert.equal(evidence.status, "needs_attention");
    return Promise.resolve();
  });

  await check("buildPolicyEvidence: a missing required commit is needs_attention, never a false success", () => {
    const policy = policyWith({ requireCleanCommit: true });
    const evidence = buildPolicyEvidence({
      policy,
      checks: [],
      cleanCommit: false,
      pullRequest: verifyPullRequest(policy, undefined),
      changedFiles: { ok: true, violations: [] },
    });
    assert.equal(evidence.status, "needs_attention");
    return Promise.resolve();
  });

  await check("buildPolicyEvidence: a failed required check always fails the run outright", () => {
    const policy = defaultExecutionPolicy();
    const evidence = buildPolicyEvidence({
      policy,
      checks: [{ id: "test", exitCode: 1, durationMs: 10, ok: false, timedOut: false, summary: "FAIL" }],
      cleanCommit: true,
      pullRequest: verifyPullRequest(policy, undefined),
      changedFiles: { ok: true, violations: [] },
    });
    assert.equal(evidence.status, "failed");
  });

  await check("buildPolicyEvidence: everything satisfied reports succeeded", () => {
    const policy = policyWith({ requireCleanCommit: true, requirePr: true });
    const evidence = buildPolicyEvidence({
      policy,
      checks: [{ id: "test", exitCode: 0, durationMs: 10, ok: true, timedOut: false, summary: "ok" }],
      cleanCommit: true,
      pullRequest: verifyPullRequest(policy, { url: "https://github.com/o/r/pull/2", number: 2, state: "open" }),
      changedFiles: { ok: true, violations: [] },
    });
    assert.equal(evidence.status, "succeeded");
    assert.deepEqual(evidence.violations, []);
  });

  if (failures > 0) {
    console.error(`\n${failures} job-policy test(s) failed`);
    process.exit(1);
  }
  console.log("\nall job-policy tests passed");
}

void main();
