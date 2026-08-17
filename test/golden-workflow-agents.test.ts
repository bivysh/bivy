// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Golden-workflow certification. Live model credentials do not belong in
// CI, so the agent boundary is deterministic; everything after the adapter has
// produced a change is real: isolated worktree, check execution, commit, push,
// idempotent PR creation, canonical outcome, correlated audit evidence, and the
// Receipt projection. Running the identical contract for both recommended
// adapter ids prevents the product path from quietly becoming agent-specific.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { receiptV1FromRun, runFromQueueItem, type GithubQueueItem } from "../packages/core/src/index.js";
import { receiptEvidenceFromAudit } from "../src/audit/receipt-evidence.js";
import { runRequiredAutomationChecks } from "../src/automation-checks.js";
import { commitAll, openPullRequest, pushBranch, type GitHubTaskConfig } from "../src/github-tasks.js";
import { listRuntimes } from "../src/runtime/index.js";
import { createWorktree } from "../src/worktree.js";

const exec = promisify(execFile);
const RECOMMENDED = ["claude-code-sdk", "codex-approvals"] as const;

async function initRepository(root: string): Promise<{ repo: string; bare: string }> {
  const repo = path.join(root, "repo");
  const bare = path.join(root, "origin.git");
  fs.mkdirSync(repo, { recursive: true });
  await exec("git", ["init", "-q", "-b", "main", repo]);
  await exec("git", ["-C", repo, "config", "user.email", "golden@bivy.test"]);
  await exec("git", ["-C", repo, "config", "user.name", "Bivy Golden Test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "golden workflow\n");
  await exec("git", ["-C", repo, "add", "-A"]);
  await exec("git", ["-C", repo, "commit", "-qm", "init"]);
  await exec("git", ["init", "-q", "--bare", "-b", "main", bare]);
  await exec("git", ["-C", repo, "remote", "add", "origin", bare]);
  await exec("git", ["-C", repo, "push", "-q", "origin", "main"]);
  return { repo, bare };
}

async function certify(runtimeId: typeof RECOMMENDED[number], repo: string, bare: string): Promise<void> {
  const runtime = listRuntimes().find((candidate) => candidate.id === runtimeId);
  assert.ok(runtime, `${runtimeId} remains registered`);
  assert.equal(runtime.supportTier, "supported", `${runtimeId} remains a supported adapter`);
  assert.match(runtime.testedVersion ?? "", /^\d+\.\d+\.\d+/, `${runtimeId} pins its certified version`);
  const capabilities = runtime.capabilities as Record<string, unknown>;
  for (const capability of ["toolInterception", "resume", "modelSelection"]) {
    assert.equal(capabilities[capability], true, `${runtimeId} supports ${capability}`);
  }

  const suffix = runtimeId === "claude-code-sdk" ? "claude" : "codex";
  const wt = await createWorktree({ repoDir: repo, id: `golden-${suffix}` });
  // Deterministic stand-in for the credentialed model turn. The adapter identity
  // above is real; no transcript or provider secret enters the resulting Run.
  fs.writeFileSync(path.join(wt.path, `${suffix}.txt`), `change produced through ${runtimeId}\n`);
  fs.writeFileSync(path.join(wt.path, "package.json"), JSON.stringify({
    name: `golden-${suffix}`,
    scripts: { test: "node -e \"process.exit(0)\"" },
  }));
  assert.equal(await commitAll(wt.path, `Golden workflow (${runtime.displayName})`), true);

  const checks = runRequiredAutomationChecks(wt.path, { ...process.env, BIVY_AUTOMATION_CHECKS: "test" });
  assert.deepEqual(checks.map(({ name, status }) => ({ name, status })), [{ name: "test", status: "passed" }]);
  const cfg = { token: "test", owner: "bivy", repo: "golden" } as GitHubTaskConfig;
  await pushBranch(cfg, wt.path, wt.branch, bare);

  const realFetch = globalThis.fetch;
  let created = false;
  let posts = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const pr = { html_url: `https://github.test/bivy/golden/pull/${suffix}`, number: suffix === "claude" ? 1 : 2 };
    if (method === "GET" && url.includes("/pulls?state=open")) return new Response(JSON.stringify(created ? [pr] : []), { status: 200 });
    if (method === "POST" && url.endsWith("/pulls")) { created = true; posts++; return new Response(JSON.stringify(pr), { status: 201 }); }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  let pr: { url: string; number: number };
  try {
    pr = await openPullRequest(cfg, { head: wt.branch, base: "main", title: `Golden ${suffix}`, body: "Golden workflow" });
    assert.deepEqual(await openPullRequest(cfg, { head: wt.branch, base: "main", title: `Golden ${suffix}`, body: "Golden workflow" }), pr);
    assert.equal(posts, 1, `${runtimeId} creates exactly one PR`);
  } finally {
    globalThis.fetch = realFetch;
  }

  const evidence = receiptEvidenceFromAudit([
    { ts: 1, kind: "approval.request", session: `session-${suffix}`, tool: "write" },
    { ts: 2, kind: "approval.decision", session: `session-${suffix}`, requestId: "approval-1", approved: true },
    { ts: 3, kind: "file.change", session: `session-${suffix}`, path: `${suffix}.txt`, op: "created", added: 1, removed: 0 },
  ], true);
  const record: GithubQueueItem = {
    id: `run-${suffix}`,
    source: "github:issue",
    repo: "bivy/golden",
    issueNumber: suffix === "claude" ? 1 : 2,
    status: "succeeded",
    label: "bivy/golden",
    title: `Golden workflow with ${runtime.displayName}`,
    createdAt: "2026-08-13T00:00:00.000Z",
    startedAt: "2026-08-13T00:00:01.000Z",
    completedAt: "2026-08-13T00:01:00.000Z",
    claimedByNodeId: "persistent-machine",
    runtimeId,
    model: suffix === "claude" ? "claude-opus-4-8" : "gpt-5-codex",
    approvalMode: "risky",
    sandbox: "workspace-write",
    checks: checks.map(({ name, status }) => ({ name, status })),
    receiptEvidence: evidence,
    output: { sessionId: `session-${suffix}`, branch: wt.branch, prUrl: pr.url },
  };
  const run = runFromQueueItem(record, { resolveMachineName: () => "Persistent test Machine" });
  assert.equal(run.outcome.kind, "pr_open", `${runtimeId} reaches the explicit PR-open outcome`);
  const receipt = receiptV1FromRun(run, "2026-08-13T00:01:01.000Z");
  assert.equal(receipt.runId, record.id);
  assert.equal(receipt.sessionId, record.output?.sessionId);
  assert.equal(receipt.execution.agentId, runtimeId);
  assert.deepEqual(receipt.checks.map(({ name, status }) => ({ name, status })), [{ name: "test", status: "passed" }]);
  assert.equal(receipt.approvals.approved, 1);
  assert.equal(JSON.stringify(receipt).includes("change produced through"), false, "Receipt excludes file and transcript content");
}

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-two-agent-golden-"));
  try {
    const { repo, bare } = await initRepository(root);
    for (const runtimeId of RECOMMENDED) await certify(runtimeId, repo, bare);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log("golden-workflow-agents: Claude Code and Codex passed the shared Run contract");
}

main().catch((error) => {
  console.error("golden-workflow-agents: FAILED\n", error);
  process.exit(1);
});
