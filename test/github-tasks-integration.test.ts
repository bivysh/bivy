import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWorktree } from "../src/worktree.js";
import {
  GitHubTaskPoller,
  loadGitHubTaskConfig,
  commitAll,
  pushBranch,
  type GitHubTaskConfig,
} from "../src/github-tasks.js";

const exec = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Verifies the real git mechanics of the issue→PR loop without GitHub: an agent
 * "writes" a file in a worktree, then commit → push lands the branch on a local
 * bare remote. Also exercises the poller's claim→run orchestration with a stubbed
 * GitHub REST layer. (A live run against real GitHub + an LLM needs the user's
 * token and model keys — see the final summary.)
 */

async function gitMechanics() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-e2e-"));
  const repo = path.join(tmp, "repo");
  const bare = path.join(tmp, "origin.git");
  fs.mkdirSync(repo, { recursive: true });

  await exec("git", ["init", "-q", "-b", "main", repo]);
  await exec("git", ["-C", repo, "config", "user.email", "t@t"]);
  await exec("git", ["-C", repo, "config", "user.name", "t"]);
  fs.writeFileSync(path.join(repo, "README.md"), "hi\n");
  await exec("git", ["-C", repo, "add", "-A"]);
  await exec("git", ["-C", repo, "commit", "-qm", "init"]);
  await exec("git", ["init", "-q", "--bare", "-b", "main", bare]);
  await exec("git", ["-C", repo, "remote", "add", "origin", bare]);
  await exec("git", ["-C", repo, "push", "-q", "origin", "main"]);

  // The agent works in an isolated worktree (forced for issue pickup).
  const wt = await createWorktree({ repoDir: repo, id: "issue-1" });
  fs.writeFileSync(path.join(wt.path, "feature.txt"), "the agent did this\n");

  const committed = await commitAll(wt.path, "Add feature (#1)");
  assert.equal(committed, true, "commitAll commits the agent's changes");

  const cfg = { token: "x", owner: "o", repo: "r" } as GitHubTaskConfig;
  await pushBranch(cfg, wt.path, wt.branch, bare); // local bare stands in for GitHub

  // The branch and the file landed on the remote.
  const branches = await exec("git", ["-C", bare, "branch", "--list", "bivy/issue-1"]);
  assert.ok(branches.stdout.includes("bivy/issue-1"), "branch pushed to remote");
  const tree = await exec("git", ["-C", bare, "ls-tree", "-r", "--name-only", "bivy/issue-1"]);
  assert.ok(tree.stdout.includes("feature.txt"), "agent's file is on the pushed branch");

  // No-op case: committing again with nothing staged returns false.
  assert.equal(await commitAll(wt.path, "noop"), false, "commitAll returns false when clean");

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("  ok  git mechanics: worktree → commit → push → branch on remote");
}

async function pollerOrchestration() {
  const realFetch = globalThis.fetch;
  const labelPosts: number[] = [];
  // Stub GitHub REST: list returns one actionable issue; label POST is recorded.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.includes("/issues?")) {
      return new Response(JSON.stringify([{ number: 5, title: "Do thing", body: "b", html_url: "u", labels: [{ name: "bivy" }] }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (method === "POST" && /\/issues\/5\/labels$/.test(url)) {
      labelPosts.push(5);
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    const cfg = loadGitHubTaskConfig({
      BIVY_GITHUB_TOKEN: "t",
      BIVY_GITHUB_REPO: "a/b",
      BIVY_GITHUB_REPO_DIR: "/x",
      BIVY_GITHUB_POLL_MS: "9999999", // only the immediate tick runs during the test
    })!;
    const ran: number[] = [];
    const poller = new GitHubTaskPoller(cfg, async (issue) => {
      ran.push(issue.number);
    });
    poller.start();
    await sleep(150);
    poller.stop();

    assert.deepEqual(ran, [5], "poller runs the one actionable issue");
    assert.deepEqual(labelPosts, [5], "poller claims the issue with the claim label before running");
    console.log("  ok  poller orchestration: list → claim → runTask");
  } finally {
    globalThis.fetch = realFetch;
  }
}

async function main() {
  await gitMechanics();
  await pollerOrchestration();
  console.log("\ngithub-tasks integration: all checks passed");
}

main().catch((error) => {
  console.error("github-tasks integration: FAILED\n", error);
  process.exit(1);
});
