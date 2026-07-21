import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadGitHubTaskConfig,
  parseIssue,
  parseRepoSlug,
  selectActionableIssues,
  buildTaskPrompt,
  DEFAULT_ISSUE_INSTRUCTIONS,
  ensureLabel,
  ensureTaskLabels,
  addLabel,
  removeLabel,
  pickupMessage,
  announcePickup,
  findOpenPullRequestForBranch,
  findMergedPullRequestForBranch,
  issueBranchName,
  pickMergedPr,
  updatePullRequest,
  parsePrContent,
  branchDiff,
  mergeBaseIntoBranch,
  completeMerge,
  abortMerge,
  unmergedPaths,
  fileHasConflictMarkers,
  type GitHubTaskConfig,
  type GitHubIssue,
} from "../src/github-tasks.js";

const execAsync = promisify(execFile);

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${(error as Error).message}`);
  }
}

// Async checks run SEQUENTIALLY: each swaps the global fetch stub, so they must
// not overlap.
const asyncChecks: Array<{ name: string; fn: () => Promise<void> }> = [];
function checkAsync(name: string, fn: () => Promise<void>) {
  asyncChecks.push({ name, fn });
}
async function runAsyncChecks() {
  for (const { name, fn } of asyncChecks) {
    try {
      await fn();
      console.log(`  ok  ${name}`);
    } catch (error) {
      failures += 1;
      console.error(`FAIL  ${name}\n      ${(error as Error).message}`);
    }
  }
}

const labelCfg: GitHubTaskConfig = {
  token: "tok",
  owner: "petter",
  repo: "bivy",
  repoDir: "/repo",
  label: "bivy/laptop",
  claimLabel: "bivy:in-progress",
  pollMs: 60_000,
};

/** Swap global.fetch for a recorder, returning the captured calls + a restore fn. */
function stubFetch(status: number | ((url: string) => number)) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: { method?: string; body?: string }) => {
    const code = typeof status === "function" ? status(url) : status;
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) : undefined });
    return { ok: code >= 200 && code < 300, status: code, json: async () => ({}), text: async () => "" } as Response;
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

/** Like stubFetch but lets a test control the JSON body returned by fetch. */
function stubFetchJson(status: number, body: unknown) {
  const calls: Array<{ url: string }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    calls.push({ url });
    return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => "" } as Response;
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

check("config: disabled without token/repo", () => {
  assert.equal(loadGitHubTaskConfig({}), null);
  assert.equal(loadGitHubTaskConfig({ BIVY_GITHUB_TOKEN: "t" }), null);
});

check("config: parses owner/repo and defaults", () => {
  const cfg = loadGitHubTaskConfig({
    BIVY_GITHUB_TOKEN: "tok",
    BIVY_GITHUB_REPO: "petter/bivy",
    BIVY_GITHUB_REPO_DIR: "/repo",
  });
  assert.ok(cfg);
  assert.equal(cfg!.owner, "petter");
  assert.equal(cfg!.repo, "bivy");
  assert.equal(cfg!.label, "bivy");
  assert.equal(cfg!.claimLabel, "bivy:in-progress");
  assert.ok(cfg!.pollMs >= 10_000);
});

check("config: poll interval has a floor", () => {
  const cfg = loadGitHubTaskConfig({
    BIVY_GITHUB_TOKEN: "t",
    BIVY_GITHUB_REPO: "a/b",
    BIVY_GITHUB_REPO_DIR: "/r",
    BIVY_GITHUB_POLL_MS: "1000",
  });
  assert.equal(cfg!.pollMs, 10_000);
});

check("parseRepoSlug: handles https and ssh remotes", () => {
  assert.equal(parseRepoSlug("https://github.com/bivysh/bivy.git"), "bivysh/bivy");
  assert.equal(parseRepoSlug("https://github.com/bivysh/bivy"), "bivysh/bivy");
  assert.equal(parseRepoSlug("git@github.com:bivysh/bivy.git"), "bivysh/bivy");
  assert.equal(parseRepoSlug("https://gitlab.com/x/y.git"), undefined);
});

check("parseIssue: normalises labels (string + object)", () => {
  const issue = parseIssue({ number: 7, title: "T", body: "B", html_url: "u", labels: ["bivy", { name: "bug" }, {}] });
  assert.deepEqual(issue.labels, ["bivy", "bug"]);
  assert.equal(issue.number, 7);
});

check("selectActionableIssues: drops claimed and invalid", () => {
  const issues: GitHubIssue[] = [
    { number: 1, title: "a", body: "", labels: ["bivy"], url: "" },
    { number: 2, title: "b", body: "", labels: ["bivy", "bivy:in-progress"], url: "" },
    { number: 0, title: "bad", body: "", labels: ["bivy"], url: "" },
  ];
  const out = selectActionableIssues(issues, "bivy:in-progress");
  assert.deepEqual(out.map((i) => i.number), [1]);
});

check("buildTaskPrompt: includes number, title, body, and instructs the agent to open its own PR", () => {
  const prompt = buildTaskPrompt({ number: 9, title: "Add X", body: "Please add X.", labels: [], url: "" });
  assert.ok(prompt.includes("#9"));
  assert.ok(prompt.includes("Add X"));
  assert.ok(prompt.includes("Please add X."));
  assert.ok(/open a pull request yourself/i.test(prompt));
  assert.ok(/tests, linter, and type-checker/i.test(prompt));
});

check("buildTaskPrompt: handles empty body", () => {
  const prompt = buildTaskPrompt({ number: 1, title: "T", body: "", labels: [], url: "" });
  assert.ok(prompt.includes("(no description provided)"));
});

check("buildTaskPrompt: a custom instructions override replaces the default", () => {
  const custom = "Just fix it and open a PR titled 'done'.";
  const prompt = buildTaskPrompt({ number: 9, title: "Add X", body: "Please add X.", labels: [], url: "" }, custom);
  assert.ok(prompt.includes(custom));
  assert.ok(!prompt.includes(DEFAULT_ISSUE_INSTRUCTIONS));
});

check("buildTaskPrompt: a blank/whitespace-only override falls back to the default", () => {
  const prompt = buildTaskPrompt({ number: 2, title: "T", body: "b", labels: [], url: "" }, "   ");
  assert.ok(prompt.includes(DEFAULT_ISSUE_INSTRUCTIONS));
});

checkAsync("ensureLabel: treats 201 created and 422 exists as success", async () => {
  let s = stubFetch(201);
  assert.equal(await ensureLabel(labelCfg, "bivy/laptop"), true);
  assert.equal(s.calls[0].url, "https://api.github.com/repos/petter/bivy/labels");
  assert.deepEqual((s.calls[0].body as { name: string }).name, "bivy/laptop");
  s.restore();

  s = stubFetch(422);
  assert.equal(await ensureLabel(labelCfg, "bivy/laptop"), true);
  s.restore();
});

checkAsync("ensureLabel: other failures (e.g. 403 missing scope) return false", async () => {
  const s = stubFetch(403);
  assert.equal(await ensureLabel(labelCfg, "bivy/laptop"), false);
  s.restore();
});

checkAsync("ensureTaskLabels: creates both the pickup and claim labels", async () => {
  const s = stubFetch(201);
  await ensureTaskLabels(labelCfg);
  const names = s.calls.map((c) => (c.body as { name: string }).name);
  assert.deepEqual(names, ["bivy/laptop", "bivy:in-progress"]);
  s.restore();
});

// ---------------------------------------------------------------------------
// Pickup signaling — comment + label lifecycle (issue #458).
// ---------------------------------------------------------------------------
check("pickupMessage: names the node when known, generic otherwise", () => {
  assert.equal(pickupMessage("laptop"), "🤖 Bivy has picked this up and started working on it on node `laptop`.");
  assert.equal(pickupMessage(), "🤖 Bivy has picked this up and started working on it.");
  assert.equal(pickupMessage("   "), "🤖 Bivy has picked this up and started working on it.");
});

checkAsync("addLabel: POSTs the label", async () => {
  const s = stubFetch(200);
  await addLabel(labelCfg, 5, "bivy:in-progress");
  assert.equal(s.calls[0].method, "POST");
  assert.ok(s.calls[0].url.endsWith("/repos/petter/bivy/issues/5/labels"));
  assert.deepEqual(s.calls[0].body, { labels: ["bivy:in-progress"] });
  s.restore();
});

checkAsync("removeLabel: DELETEs the encoded label name", async () => {
  const s = stubFetch(200);
  await removeLabel(labelCfg, 5, "bivy/laptop");
  assert.equal(s.calls[0].method, "DELETE");
  assert.ok(s.calls[0].url.endsWith(`/repos/petter/bivy/issues/5/labels/${encodeURIComponent("bivy/laptop")}`));
  s.restore();
});

checkAsync("removeLabel: a 404 (label not present) is not thrown", async () => {
  const s = stubFetch(404);
  await assert.doesNotReject(() => removeLabel(labelCfg, 5, "bivy"));
  s.restore();
});

checkAsync("announcePickup: adds the claim label, drops the routing label, and comments", async () => {
  const s = stubFetch(200);
  await announcePickup(labelCfg, 5, "laptop");
  const byMethod = (m: string) => s.calls.filter((c) => c.method === m);
  assert.equal(byMethod("POST").length, 2, "one POST to add the claim label, one to comment");
  assert.deepEqual((byMethod("POST")[0].body as { labels: string[] }).labels, ["bivy:in-progress"]);
  assert.ok((byMethod("POST")[1].body as { body: string }).body.includes("node `laptop`"));
  assert.equal(byMethod("DELETE").length, 1, "removes the routing label since it differs from the claim label");
  assert.ok(byMethod("DELETE")[0].url.includes(encodeURIComponent("bivy/laptop")));
  s.restore();
});

checkAsync("announcePickup: leaves the routing label alone when it equals the claim label", async () => {
  const cfg: GitHubTaskConfig = { ...labelCfg, label: "bivy:in-progress" };
  const s = stubFetch(200);
  await announcePickup(cfg, 5);
  assert.equal(s.calls.filter((c) => c.method === "DELETE").length, 0);
  s.restore();
});

checkAsync("announcePickup: best-effort — a failing call doesn't throw", async () => {
  const s = stubFetch(500);
  await assert.doesNotReject(() => announcePickup(labelCfg, 5, "laptop"));
  s.restore();
});

checkAsync("findOpenPullRequestForBranch: adopts an existing open PR for the branch", async () => {
  const s = stubFetchJson(200, [{ html_url: "https://github.com/petter/bivy/pull/7", number: 7 }]);
  const pr = await findOpenPullRequestForBranch(labelCfg, "bivy/session-abc");
  assert.deepEqual(pr, { url: "https://github.com/petter/bivy/pull/7", number: 7 });
  // Queries the repo's open PRs filtered by owner:branch head.
  assert.ok(s.calls[0].url.includes("/repos/petter/bivy/pulls"));
  assert.ok(s.calls[0].url.includes(encodeURIComponent("petter:bivy/session-abc")));
  assert.ok(s.calls[0].url.includes("state=open"));
  s.restore();
});

checkAsync("findOpenPullRequestForBranch: returns undefined when no PR exists", async () => {
  const s = stubFetchJson(200, []);
  assert.equal(await findOpenPullRequestForBranch(labelCfg, "bivy/session-none"), undefined);
  s.restore();
});

check("issueBranchName: deterministic per issue number", () => {
  assert.equal(issueBranchName(382), "bivy/issue-382");
  assert.equal(issueBranchName(7), "bivy/issue-7");
});

check("pickMergedPr: returns the merged PR, ignores open/closed-unmerged", () => {
  assert.equal(pickMergedPr([]), undefined);
  // Open or closed-without-merge is NOT 'resolved' — abandoned work can be redone.
  assert.equal(pickMergedPr([
    { url: "u1", number: 1, state: "open" },
    { url: "u2", number: 2, state: "closed" },
  ]), undefined);
  assert.deepEqual(pickMergedPr([
    { url: "u3", number: 3, state: "closed" },
    { url: "u4", number: 4, state: "merged" },
  ]), { url: "u4", number: 4, state: "merged" });
});

checkAsync("findMergedPullRequestForBranch: finds a prior merged PR (idempotency guard)", async () => {
  // GitHub list rep: merged PRs carry merged_at; the head ref still matches after branch deletion.
  const s = stubFetchJson(200, [
    { html_url: "https://github.com/petter/bivy/pull/9", number: 9, state: "closed", merged_at: "2026-07-15T13:00:00Z" },
  ]);
  const pr = await findMergedPullRequestForBranch(labelCfg, "bivy/issue-382");
  assert.deepEqual(pr, { url: "https://github.com/petter/bivy/pull/9", number: 9, state: "merged", title: undefined });
  assert.ok(s.calls[0].url.includes("state=all"));
  assert.ok(s.calls[0].url.includes(encodeURIComponent("petter:bivy/issue-382")));
  s.restore();
});

checkAsync("findMergedPullRequestForBranch: undefined when only an open PR exists (no duplicate-skip)", async () => {
  const s = stubFetchJson(200, [
    { html_url: "https://github.com/petter/bivy/pull/10", number: 10, state: "open", merged_at: null },
  ]);
  assert.equal(await findMergedPullRequestForBranch(labelCfg, "bivy/issue-999"), undefined);
  s.restore();
});

checkAsync("updatePullRequest: PATCHes the PR title/body and reports success", async () => {
  const s = stubFetch(200);
  const ok = await updatePullRequest(labelCfg, 7, { title: "New title", body: "New body" });
  assert.equal(ok, true);
  assert.ok(s.calls[0].url.includes("/repos/petter/bivy/pulls/7"));
  assert.deepEqual(s.calls[0].body, { title: "New title", body: "New body" });
  s.restore();
});

checkAsync("updatePullRequest: returns false on a failed update", async () => {
  const s = stubFetch(404);
  assert.equal(await updatePullRequest(labelCfg, 7, { title: "x" }), false);
  s.restore();
});

// ---------------------------------------------------------------------------
// parsePrContent — tolerant extraction of the model-written {title, body}.
// ---------------------------------------------------------------------------
check("parsePrContent: parses a clean JSON object", () => {
  assert.deepEqual(parsePrContent('{"title":"Add dark mode","body":"Adds a toggle."}'), {
    title: "Add dark mode",
    body: "Adds a toggle.",
  });
});

check("parsePrContent: strips surrounding prose / code fences", () => {
  const text = 'Here you go:\n```json\n{"title":"Fix login","body":"Handles empty email."}\n```';
  assert.deepEqual(parsePrContent(text), { title: "Fix login", body: "Handles empty email." });
});

check("parsePrContent: undefined on non-JSON or empty", () => {
  assert.equal(parsePrContent("not json"), undefined);
  assert.equal(parsePrContent(""), undefined);
  assert.equal(parsePrContent("{}"), undefined);
});

// ---------------------------------------------------------------------------
// Git merge helpers — real temp repo (no network; remoteUrl points at itself).
// ---------------------------------------------------------------------------
async function initRepo(): Promise<{ dir: string; base: string; cfg: GitHubTaskConfig }> {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bivy-merge-")));
  await execAsync("git", ["-C", dir, "init", "-q"]);
  await execAsync("git", ["-C", dir, "config", "user.email", "t@t"]);
  await execAsync("git", ["-C", dir, "config", "user.name", "t"]);
  fs.writeFileSync(path.join(dir, "file.txt"), "line1\nline2\n");
  await execAsync("git", ["-C", dir, "add", "-A"]);
  await execAsync("git", ["-C", dir, "commit", "-qm", "base"]);
  const { stdout } = await execAsync("git", ["-C", dir, "branch", "--show-current"]);
  const base = stdout.trim();
  const cfg: GitHubTaskConfig = { ...labelCfg, repoDir: dir };
  return { dir, base, cfg };
}

checkAsync("mergeBaseIntoBranch: clean merge when the base advanced without conflict", async () => {
  const { dir, base, cfg } = await initRepo();
  try {
    await execAsync("git", ["-C", dir, "checkout", "-q", "-b", "feature"]);
    fs.writeFileSync(path.join(dir, "other.txt"), "feature-only\n");
    await execAsync("git", ["-C", dir, "add", "-A"]);
    await execAsync("git", ["-C", dir, "commit", "-qm", "feature"]);
    await execAsync("git", ["-C", dir, "checkout", "-q", base]);
    fs.writeFileSync(path.join(dir, "file.txt"), "line1\nline2\nline3\n"); // non-conflicting
    await execAsync("git", ["-C", dir, "add", "-A"]);
    await execAsync("git", ["-C", dir, "commit", "-qm", "advance base"]);
    await execAsync("git", ["-C", dir, "checkout", "-q", "feature"]);

    const res = await mergeBaseIntoBranch(cfg, dir, base, dir);
    assert.equal(res.status, "clean");
    assert.deepEqual(res.conflicts, []);
    assert.deepEqual(await unmergedPaths(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

checkAsync("mergeBaseIntoBranch: conflict → agent resolves → completeMerge commits", async () => {
  const { dir, base, cfg } = await initRepo();
  try {
    await execAsync("git", ["-C", dir, "checkout", "-q", "-b", "feature"]);
    fs.writeFileSync(path.join(dir, "file.txt"), "line1\nFEATURE\n");
    await execAsync("git", ["-C", dir, "add", "-A"]);
    await execAsync("git", ["-C", dir, "commit", "-qm", "feature"]);
    await execAsync("git", ["-C", dir, "checkout", "-q", base]);
    fs.writeFileSync(path.join(dir, "file.txt"), "line1\nMAIN\n");
    await execAsync("git", ["-C", dir, "add", "-A"]);
    await execAsync("git", ["-C", dir, "commit", "-qm", "main change"]);
    await execAsync("git", ["-C", dir, "checkout", "-q", "feature"]);

    const res = await mergeBaseIntoBranch(cfg, dir, base, dir);
    assert.equal(res.status, "conflicts");
    assert.ok(res.conflicts.includes("file.txt"));
    assert.ok((await unmergedPaths(dir)).includes("file.txt"));
    assert.equal(fileHasConflictMarkers(dir, "file.txt"), true);

    // "Agent" resolves the conflict, then we complete the merge.
    fs.writeFileSync(path.join(dir, "file.txt"), "line1\nRESOLVED\n");
    assert.equal(fileHasConflictMarkers(dir, "file.txt"), false);
    assert.equal(await completeMerge(dir, res.conflicts), true);
    assert.deepEqual(await unmergedPaths(dir), []);

    // The merge commit exists and the tree is clean.
    const { stdout } = await execAsync("git", ["-C", dir, "status", "--porcelain"]);
    assert.equal(stdout.trim(), "");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

checkAsync("completeMerge: refuses to commit while conflict markers remain, abortMerge restores", async () => {
  const { dir, base, cfg } = await initRepo();
  try {
    await execAsync("git", ["-C", dir, "checkout", "-q", "-b", "feature"]);
    fs.writeFileSync(path.join(dir, "file.txt"), "line1\nFEATURE\n");
    await execAsync("git", ["-C", dir, "add", "-A"]);
    await execAsync("git", ["-C", dir, "commit", "-qm", "feature"]);
    await execAsync("git", ["-C", dir, "checkout", "-q", base]);
    fs.writeFileSync(path.join(dir, "file.txt"), "line1\nMAIN\n");
    await execAsync("git", ["-C", dir, "add", "-A"]);
    await execAsync("git", ["-C", dir, "commit", "-qm", "main change"]);
    await execAsync("git", ["-C", dir, "checkout", "-q", "feature"]);

    const res = await mergeBaseIntoBranch(cfg, dir, base, dir);
    assert.equal(res.status, "conflicts");
    // Markers still present → completeMerge must not commit a broken tree.
    assert.equal(await completeMerge(dir, res.conflicts), false);

    await abortMerge(dir);
    const { stdout } = await execAsync("git", ["-C", dir, "status", "--porcelain"]);
    assert.equal(stdout.trim(), "", "abortMerge restores a clean tree");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

checkAsync("branchDiff: shows the branch's own additions over base", async () => {
  const { dir, base } = await initRepo();
  try {
    await execAsync("git", ["-C", dir, "checkout", "-q", "-b", "feature"]);
    fs.writeFileSync(path.join(dir, "added.txt"), "brand new\n");
    await execAsync("git", ["-C", dir, "add", "-A"]);
    await execAsync("git", ["-C", dir, "commit", "-qm", "add file"]);

    const diff = await branchDiff(dir, base);
    assert.ok(diff.includes("added.txt"), "diff names the new file");
    assert.ok(diff.includes("brand new"), "diff includes the added content");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await runAsyncChecks();

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log("\ngithub-tasks: all tests passed");
