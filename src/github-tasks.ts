// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import type { PrRef, PrState } from "./metadata.js";
import { cleanRemoteUrl, credConfigArgs, gitNonInteractiveEnv } from "./git-auth.js";

const exec = promisify(execFile);

/**
 * GitHub issue pickup — "a todo-list the agent works on".
 *
 * The node polls GitHub for open issues carrying its label, and runs each in an
 * isolated worktree on its own machine (with its own token, so code never leaves
 * the box). The agent itself does the git work: it commits, pushes its branch,
 * and opens the pull request (referencing/closing the issue) — guided by a
 * first-message prompt (`buildTaskPrompt`) whose instructions are shipped with a
 * strong default but are user-editable (Settings → Nodes → GitHub issue prompt).
 * The node still publishes the branch and adopts a PR the agent opens itself
 * (see `maybePushWorktreeBranch`/`maybeDetectPullRequest` in src/server.ts) —
 * but it no longer opens or writes the PR's title/body itself. This is the
 * self-hosted equivalent of the issue→agent→PR pattern (Copilot coding agent,
 * Devin, Cursor background agents) — except it runs on machines you own.
 *
 * Explicit routing: a node only picks up issues that carry its `label`
 * (e.g. `bivy` or `bivy/<node>`). A claim label added on pickup prevents
 * double-processing across restarts/nodes. See docs/product-definition.md (work
 * queue) and docs/DEVELOPMENT_PLAN.md (Phase E). This direct poller is now the
 * local/self-hosted fallback; the hosted default is GitHub webhook push into the
 * control-plane work queue, with relay push hints to connected nodes.
 *
 * Pure helpers (config/parse/select/prompt) are unit-tested in
 * test/github-tasks.test.ts; the network + agent loop needs manual verification.
 */

export interface GitHubTaskConfig {
  token: string;
  owner: string;
  repo: string;
  repoDir: string; // local checkout the worktrees branch from
  label: string; // pick up issues carrying this label
  claimLabel: string; // marker added on pickup
  pollMs: number;
}

/** Parse an "owner/repo" slug from a git remote URL (https or ssh form). */
export function parseRepoSlug(remoteUrl: string): string | undefined {
  const m = remoteUrl.trim().match(/github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}` : undefined;
}

/** `gh auth token` for the logged-in user, or undefined if gh isn't available. */
async function ghAuthToken(): Promise<string | undefined> {
  try {
    const { stdout } = await exec("gh", ["auth", "token"]);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Infer "owner/repo" from the repo's origin remote. */
async function inferRepoSlug(repoDir: string): Promise<string | undefined> {
  try {
    const { stdout } = await exec("git", ["-C", repoDir, "remote", "get-url", "origin"]);
    return parseRepoSlug(stdout);
  } catch {
    return undefined;
  }
}

/**
 * Resolve config from env, falling back to the local `gh`/git setup so a machine
 * that already has `gh` logged in needs (almost) no env vars. Enabled when either
 * the explicit env (token+repo) is present, OR `BIVY_GITHUB_TASKS=1` opts in to
 * gh/git inference (so a node never starts polling unexpectedly).
 */
export async function resolveGitHubTaskConfig(env: NodeJS.ProcessEnv = process.env): Promise<GitHubTaskConfig | null> {
  const repoDir = env.BIVY_GITHUB_REPO_DIR?.trim() || env.BIVY_WORKSPACE?.trim() || process.cwd();
  const explicit = Boolean(env.BIVY_GITHUB_TOKEN?.trim() && env.BIVY_GITHUB_REPO?.trim());
  const optedIn = env.BIVY_GITHUB_TASKS === "1";
  if (!explicit && !optedIn) return null; // off unless asked for

  const token = env.BIVY_GITHUB_TOKEN?.trim() || (await ghAuthToken());
  const repoSlug = env.BIVY_GITHUB_REPO?.trim() || (await inferRepoSlug(repoDir));
  if (!token) {
    console.warn("[github-tasks] enabled but no token — set BIVY_GITHUB_TOKEN or run `gh auth login`");
    return null;
  }
  if (!repoSlug) {
    console.warn("[github-tasks] enabled but could not determine the repo — set BIVY_GITHUB_REPO or run inside a GitHub checkout");
    return null;
  }
  const [owner, repo] = repoSlug.split("/");
  if (!owner || !repo) return null;
  return {
    token,
    owner,
    repo,
    repoDir,
    label: env.BIVY_GITHUB_LABEL?.trim() || "bivy",
    claimLabel: env.BIVY_GITHUB_CLAIM_LABEL?.trim() || "bivy:in-progress",
    pollMs: Math.max(Number(env.BIVY_GITHUB_POLL_MS) || 60_000, 10_000),
  };
}

/** Pure, env-only config (no gh/git fallback). Kept for tests and explicit setups. */
export function loadGitHubTaskConfig(env: NodeJS.ProcessEnv = process.env): GitHubTaskConfig | null {
  const token = env.BIVY_GITHUB_TOKEN?.trim();
  const repoSlug = env.BIVY_GITHUB_REPO?.trim(); // "owner/repo"
  const repoDir = env.BIVY_GITHUB_REPO_DIR?.trim() || env.BIVY_WORKSPACE?.trim();
  if (!token || !repoSlug || !repoDir) return null;
  const [owner, repo] = repoSlug.split("/");
  if (!owner || !repo) return null;
  return {
    token,
    owner,
    repo,
    repoDir,
    label: env.BIVY_GITHUB_LABEL?.trim() || "bivy",
    claimLabel: env.BIVY_GITHUB_CLAIM_LABEL?.trim() || "bivy:in-progress",
    pollMs: Math.max(Number(env.BIVY_GITHUB_POLL_MS) || 60_000, 10_000),
  };
}

export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  url: string;
}

export function parseIssue(raw: unknown): GitHubIssue {
  const o = (raw ?? {}) as Record<string, unknown>;
  const labels = Array.isArray(o.labels)
    ? o.labels.map((l) => (typeof l === "string" ? l : (l as { name?: string })?.name)).filter((n): n is string => Boolean(n))
    : [];
  return {
    number: Number(o.number) || 0,
    title: String(o.title ?? ""),
    body: String(o.body ?? ""),
    labels,
    url: String(o.html_url ?? ""),
  };
}

/** Open, labelled issues not already claimed (PRs are filtered upstream). */
export function selectActionableIssues(issues: GitHubIssue[], claimLabel: string): GitHubIssue[] {
  return issues.filter((issue) => issue.number > 0 && !issue.labels.includes(claimLabel));
}

/**
 * The default instructions appended to every issue-pickup prompt (after the
 * issue's own number/title/body/link). User-editable — see the
 * `githubIssuePrompt` node setting (Settings → Nodes) and `buildTaskPrompt`'s
 * `instructions` param — so this is a strong starting point, not the only
 * option. It intentionally puts the agent in charge of the whole loop
 * (understand → implement → verify → commit/push/PR) rather than having the
 * node do any of that for it.
 */
export const DEFAULT_ISSUE_INSTRUCTIONS = [
  "Understand the issue and the surrounding codebase before making any changes — read the relevant files, follow existing conventions, and figure out the right approach before writing code.",
  "",
  "Do thorough, careful work: implement the change completely, check your own work as you go, and iterate rather than stopping at a first draft.",
  "",
  "Before you consider yourself done, run this project's tests, linter, and type-checker, and fix anything they turn up.",
  "",
  "When you're finished, commit your changes, push your branch, and open a pull request yourself (for example with `gh pr create`) with a clear, descriptive title and a description that explains what changed and why. Reference and close this issue in the pull request (e.g. \"Closes #<number>\").",
  "",
  "If you can't open the pull request yourself (no `gh`/GitHub access from this environment), that's fine — just make sure your changes are committed on this branch; it can still be turned into a pull request afterwards.",
].join("\n");

/**
 * Build the agent prompt from an issue: fixed issue context (number, title,
 * body, link) followed by `instructions` — the user-editable part, defaulting
 * to `DEFAULT_ISSUE_INSTRUCTIONS` when unset/blank so a custom override that's
 * been cleared falls back cleanly.
 */
export function buildTaskPrompt(issue: GitHubIssue, instructions?: string): string {
  const links = [
    issue.url ? `Issue: ${issue.url}` : null,
  ].filter(Boolean).join("\n");
  return [
    `You are working on GitHub issue #${issue.number}: ${issue.title}`,
    "",
    issue.body?.trim() || "(no description provided)",
    "",
    links ? `${links}\n` : "",
    instructions?.trim() || DEFAULT_ISSUE_INSTRUCTIONS,
  ].join("\n");
}

/**
 * Build the prompt used to resume a session found by `reconcileOrphanedIssueWork`
 * (src/server.ts) on startup — one whose worktree still has unclaimed work
 * (uncommitted edits, or commits with no PR yet) and wasn't reopened live this
 * run. Any such session was, by construction, cut off mid-task by the node
 * process dying (crash, OOM-kill, redeploy) rather than by the agent finishing
 * or a human stopping it — see issue #125 ("Agent should resume its task
 * automatically after a session restart"). Unlike `buildTaskPrompt`, this does
 * NOT restate the issue as a new request: it tells the agent plainly that it
 * was interrupted, so it picks up the existing worktree state (via `git
 * status`/`git diff`/`git log`) instead of re-deriving the task from scratch or
 * mistaking its own partial edits for someone else's.
 */
export function buildResumePrompt(issue: GitHubIssue): string {
  return [
    `You were working on GitHub issue #${issue.number}${issue.title ? `: ${issue.title}` : ""} when your session was interrupted by a restart — not because you finished the task or a human told you to stop.`,
    "",
    "Resume exactly where you left off. Start by checking `git status`, `git diff`, and `git log` in this worktree to see what you'd already changed or committed, then finish the task from there.",
    "",
    "Before you consider yourself done, run this project's tests, linter, and type-checker, and fix anything they turn up.",
    "",
    "When you're finished, commit and push your changes yourself. If this branch already has an open pull request, leave it — just make sure it reflects the finished work; otherwise open one yourself, referencing this issue.",
  ].join("\n");
}

/** The nudge sent to a non-issue (interactive/chat) session whose turn was cut
 *  off by a process restart. Unlike the issue prompt it makes no assumptions
 *  about a git worktree or a task to report on — it just tells the agent it was
 *  interrupted and to finish what it was doing, so it works for any session. */
export function buildInteractiveResumePrompt(): string {
  return [
    "Your previous turn was interrupted by a restart before it finished — not because you completed the task or were told to stop.",
    "",
    "Pick up exactly where you left off and finish what you were doing. Review the recent conversation to recall your plan; if you're in a code workspace, check `git status` and `git diff` to see the work already in progress before continuing.",
  ].join("\n");
}

/** Parse optional bivy directives from issue body for agent/model selection.
 *  Supports lines like:
 *    bivy-agent: pi
 *    bivy-model: claude-3-5-sonnet-20241022
 *    agent: pi
 *    model: gpt-4o
 *  Returns { runtimeId?, model? }
 */
export function parseBivyDirectives(body: string | undefined): { runtimeId?: string; model?: string } {
  const out: { runtimeId?: string; model?: string } = {};
  if (!body) return out;
  const lines = body.split(/\r?\n/);
  for (const line of lines) {
    const m = /^\s*(?:bivy-)?(?:agent|runtime)\s*[:=]\s*([^\s#]+)/i.exec(line);
    if (m) out.runtimeId = m[1].trim();
    const mm = /^\s*(?:bivy-)?model\s*[:=]\s*([^\s#]+)/i.exec(line);
    if (mm) out.model = mm[1].trim();
  }
  return out;
}

async function gh(cfg: GitHubTaskConfig, method: string, apiPath: string, body?: unknown): Promise<Response> {
  return fetch(`https://api.github.com/repos/${cfg.owner}/${cfg.repo}${apiPath}`, {
    method,
    headers: {
      authorization: `Bearer ${cfg.token}`,
      accept: "application/vnd.github+json",
      "user-agent": "bivy",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

export async function listOpenLabelledIssues(cfg: GitHubTaskConfig): Promise<GitHubIssue[]> {
  const res = await gh(cfg, "GET", `/issues?state=open&labels=${encodeURIComponent(cfg.label)}&per_page=20`);
  if (!res.ok) return [];
  const raw = (await res.json().catch(() => [])) as Array<Record<string, unknown>>;
  // The issues endpoint also returns PRs; drop anything with a pull_request field.
  return (Array.isArray(raw) ? raw : []).filter((r) => !r.pull_request).map(parseIssue);
}

export async function getIssue(cfg: GitHubTaskConfig, issueNumber: number): Promise<GitHubIssue | undefined> {
  const res = await gh(cfg, "GET", `/issues/${issueNumber}`);
  if (!res.ok) return undefined;
  const raw = (await res.json().catch(() => undefined)) as (Record<string, unknown> | undefined);
  if (!raw || raw.pull_request) return undefined;
  return parseIssue(raw);
}

/** Fetch a triggering issue comment's body directly from GitHub (issue #153) —
 *  the control plane no longer retains it, only the comment URL, whose stable
 *  `issuecomment-<id>` anchor is enough for the authorized, claiming node to
 *  retrieve the live text just in time. */
export async function getIssueCommentBody(cfg: GitHubTaskConfig, url: string | undefined): Promise<string | undefined> {
  const id = url?.match(/#issuecomment-(\d+)$/)?.[1];
  if (!id) return undefined;
  const res = await gh(cfg, "GET", `/issues/comments/${id}`);
  if (!res.ok) return undefined;
  const raw = (await res.json().catch(() => undefined)) as { body?: unknown } | undefined;
  return typeof raw?.body === "string" ? raw.body : undefined;
}

export async function addLabel(cfg: GitHubTaskConfig, issueNumber: number, label: string): Promise<void> {
  await gh(cfg, "POST", `/issues/${issueNumber}/labels`, { labels: [label] });
}

/**
 * Remove a label from an issue, if present. Best-effort: GitHub 404s when the
 * label isn't on the issue (already removed, never applied), which is a no-op
 * for our purposes, not a failure — callers don't need to check the label was
 * there first. Used to move an issue from its routing label (e.g. `bivy`) to
 * the claim label on pickup, and to drop the claim label once a PR carries the
 * "in progress" signal instead.
 */
export async function removeLabel(cfg: GitHubTaskConfig, issueNumber: number, label: string): Promise<void> {
  await gh(cfg, "DELETE", `/issues/${issueNumber}/labels/${encodeURIComponent(label)}`);
}

/**
 * Create a repo label if it does not already exist. Idempotent: GitHub returns
 * 422 ("already_exists") when the label is present, which we treat as success.
 * Returns true if the label exists (created now or already there), false if the
 * call failed for another reason (e.g. missing scope) so the caller can warn.
 */
export async function ensureLabel(
  cfg: GitHubTaskConfig,
  name: string,
  color = "5319e7",
  description = "Bivy work-queue label",
): Promise<boolean> {
  const res = await gh(cfg, "POST", "/labels", { name, color, description });
  if (res.ok) return true;
  if (res.status === 422) return true; // already exists
  return false;
}

/**
 * Make sure the node's pickup + claim labels exist on the repo so a user can
 * apply them straight away (E1: auto-create the per-node label instead of asking
 * the user to create it by hand). Best-effort and idempotent.
 */
export async function ensureTaskLabels(cfg: GitHubTaskConfig): Promise<void> {
  const ok = await ensureLabel(cfg, cfg.label, "5319e7", "Pick up with Bivy on a node you own");
  await ensureLabel(cfg, cfg.claimLabel, "fbca04", "Bivy is working this issue");
  if (!ok) {
    console.warn(`[github-tasks] could not ensure label "${cfg.label}" exists (token may lack repo scope) — apply it manually if pickup doesn't trigger`);
  }
}

export async function commentIssue(cfg: GitHubTaskConfig, issueNumber: number, body: string): Promise<void> {
  await gh(cfg, "POST", `/issues/${issueNumber}/comments`, { body });
}

/**
 * The comment posted on an issue the moment Bivy picks it up — the "visibly
 * signal pickup" half of the on-issue lifecycle (the other half is the label
 * swap in `announcePickup`). Names the node when known so a human watching a
 * multi-node setup knows which machine is doing the work.
 */
export function pickupMessage(nodeName?: string): string {
  const node = nodeName?.trim();
  return node
    ? `🤖 Bivy has picked this up and started working on it on node \`${node}\`.`
    : "🤖 Bivy has picked this up and started working on it.";
}

/**
 * Signal pickup on the issue itself: apply the claim label (`bivy:in-progress`),
 * move off the routing label that triggered pickup (e.g. `bivy`, left alone if
 * it's already the same as the claim label), and leave a comment naming the
 * node. Best-effort and idempotent — safe to call even when a caller (the
 * direct poller's tick, the manual pickup endpoint) already added the claim
 * label, and it's the only place the hosted GitHub-App path — which claims via
 * the control plane, not a GitHub label — touches the issue's labels at all.
 */
export async function announcePickup(cfg: GitHubTaskConfig, issueNumber: number, nodeName?: string): Promise<void> {
  // Best-effort and idempotent, but not silent (A4): a failed claim label can let
  // another node pick up the same issue, and a failed comment hides the pickup
  // from the reporter — both are worth a warning in the node log/diagnostics.
  const warn = (what: string, error: unknown) =>
    console.warn(`[github-tasks] issue #${issueNumber}: could not ${what}:`, error instanceof Error ? error.message : error);
  await addLabel(cfg, issueNumber, cfg.claimLabel).catch((error) => warn(`apply claim label "${cfg.claimLabel}"`, error));
  if (cfg.label && cfg.label !== cfg.claimLabel) {
    await removeLabel(cfg, issueNumber, cfg.label).catch((error) => warn(`remove routing label "${cfg.label}"`, error));
  }
  await commentIssue(cfg, issueNumber, pickupMessage(nodeName)).catch((error) => warn("post pickup comment", error));
}

export async function defaultBranch(cfg: GitHubTaskConfig): Promise<string> {
  const res = await gh(cfg, "GET", "");
  if (!res.ok) return "main";
  const data = (await res.json().catch(() => ({}))) as { default_branch?: string };
  return data.default_branch || "main";
}

export async function openPullRequest(
  cfg: GitHubTaskConfig,
  input: { head: string; base: string; title: string; body: string },
): Promise<{ url: string; number: number } | undefined> {
  const res = await gh(cfg, "POST", "/pulls", input);
  if (!res.ok) return undefined;
  const data = (await res.json().catch(() => ({}))) as { html_url?: string; number?: number };
  return data.html_url ? { url: data.html_url, number: Number(data.number) } : undefined;
}

/**
 * Update an existing pull request's title and/or body. Used to refresh the
 * agent-written summary when a follow-up @-mention adds more commits, so the PR
 * description keeps describing what's actually on the branch. Returns whether the
 * update succeeded (best-effort; a failure just leaves the previous text).
 */
export async function updatePullRequest(
  cfg: GitHubTaskConfig,
  number: number,
  input: { title?: string; body?: string },
): Promise<boolean> {
  const res = await gh(cfg, "PATCH", `/pulls/${number}`, input);
  return res.ok;
}

/**
 * Look up an already-open pull request whose head is `branch` (in this repo), or
 * undefined if there isn't one. Lets the node adopt a PR opened out-of-band — by
 * the agent's `gh pr create`, the GitHub API, or the web UI — so the session's
 * PR badge lights up regardless of how the PR was created. The `head` filter uses
 * GitHub's `owner:ref` form; PRs are always from a branch in the owner's repo.
 */
export async function findOpenPullRequestForBranch(
  cfg: GitHubTaskConfig,
  branch: string,
): Promise<{ url: string; number: number } | undefined> {
  const head = `${cfg.owner}:${branch}`;
  const res = await gh(cfg, "GET", `/pulls?state=open&head=${encodeURIComponent(head)}&per_page=1`);
  if (!res.ok) return undefined;
  const raw = (await res.json().catch(() => [])) as Array<{ html_url?: string; number?: number }>;
  const pr = Array.isArray(raw) ? raw[0] : undefined;
  return pr?.html_url ? { url: pr.html_url, number: Number(pr.number) } : undefined;
}

/**
 * List every pull request whose head is `branch` (in this repo), across all
 * states, newest-relevant first: open PRs before closed/merged, then by recency.
 * Unlike `findOpenPullRequestForBranch` this also surfaces merged/closed PRs, so
 * the UI can show a "Merged" badge and a session can carry more than one PR over
 * its life. `merged_at` (present in the list representation) distinguishes a
 * merged PR from one closed without merging.
 */
export async function findPullRequestsForBranch(
  cfg: GitHubTaskConfig,
  branch: string,
): Promise<PrRef[]> {
  const head = `${cfg.owner}:${branch}`;
  const res = await gh(cfg, "GET", `/pulls?state=all&head=${encodeURIComponent(head)}&per_page=20`);
  if (!res.ok) return [];
  const raw = (await res.json().catch(() => [])) as Array<{
    html_url?: string;
    number?: number;
    state?: string;
    title?: string;
    merged_at?: string | null;
    updated_at?: string;
  }>;
  if (!Array.isArray(raw)) return [];
  const withSort = raw
    .filter((p) => p?.html_url)
    .map((p) => ({
      pr: {
        url: p.html_url as string,
        number: Number(p.number),
        state: (p.merged_at ? "merged" : p.state === "closed" ? "closed" : "open") as PrState,
        title: typeof p.title === "string" ? p.title : undefined,
      } satisfies PrRef,
      updatedAt: typeof p.updated_at === "string" ? p.updated_at : "",
    }));
  // Open PRs first (the actionable one), then most-recently-updated. The `[0]`
  // of the result is the natural "primary" for a single badge.
  const rank = (s: PrState) => (s === "open" ? 0 : s === "merged" ? 1 : 2);
  withSort.sort((a, b) => rank(a.pr.state) - rank(b.pr.state) || b.updatedAt.localeCompare(a.updatedAt));
  return withSort.map((x) => x.pr);
}

/** The deterministic branch an issue's automation works on. One issue → one
 *  branch, so a prior run's PR is discoverable by branch name even after the
 *  branch is deleted on merge. */
export function issueBranchName(issueNumber: number): string {
  return `bivy/issue-${issueNumber}`;
}

/** The merged PR in a set, if any. A merged PR means the change already shipped,
 *  so re-running its issue would only open a duplicate. A *closed-unmerged* PR
 *  is deliberately not treated as resolved — that work was abandoned and is fine
 *  to redo. */
export function pickMergedPr(prs: PrRef[]): PrRef | undefined {
  return prs.find((p) => p.state === "merged");
}

/**
 * The merged pull request for `branch`, if the issue's work already shipped.
 * Used as an idempotency guard so a re-picked/re-dispatched/re-mentioned issue
 * doesn't open a *second* PR on top of already-merged work. Best-effort: returns
 * undefined on any lookup failure so a transient API error never blocks new work.
 */
export async function findMergedPullRequestForBranch(
  cfg: GitHubTaskConfig,
  branch: string,
): Promise<PrRef | undefined> {
  try {
    return pickMergedPr(await findPullRequestsForBranch(cfg, branch));
  } catch {
    return undefined;
  }
}

/**
 * Fetch a single pull request by number, as a PrRef (state derived the same way
 * as the list lookup). Used to reconcile PRs a session opened on *other* branches
 * — harvested from its transcript by number — which the head-branch lookups above
 * can't see. Returns undefined on any non-2xx (deleted PR, wrong repo, etc.).
 */
export async function getPullRequest(cfg: GitHubTaskConfig, number: number): Promise<PrRef | undefined> {
  const res = await gh(cfg, "GET", `/pulls/${number}`);
  if (!res.ok) return undefined;
  const p = (await res.json().catch(() => null)) as { html_url?: string; number?: number; state?: string; title?: string; merged_at?: string | null } | null;
  if (!p?.html_url) return undefined;
  return {
    url: p.html_url,
    number: Number(p.number),
    state: p.merged_at ? "merged" : p.state === "closed" ? "closed" : "open",
    title: typeof p.title === "string" ? p.title : undefined,
  };
}

/** Stage + commit everything in the worktree. Returns false if nothing changed. */
export async function commitAll(dir: string, message: string): Promise<boolean> {
  await exec("git", ["-C", dir, "add", "-A"]);
  const { stdout } = await exec("git", ["-C", dir, "status", "--porcelain"]);
  if (!stdout.trim()) return false;
  await exec("git", ["-C", dir, "-c", "user.email=bivy@local", "-c", "user.name=Bivy", "commit", "-qm", message]);
  return true;
}

/**
 * The push/fetch URL for a repo — token-FREE. Auth is supplied out-of-band by the
 * daemon credential helper (see src/git-auth.ts), which serves the token stashed
 * by `writeRepoToken`. Never embed the token in the URL: it would land in process
 * args, logs, and error messages. `remoteUrl` stays overridable for tests.
 */
export function remoteUrlFor(cfg: GitHubTaskConfig): string {
  return cleanRemoteUrl(cfg.owner, cfg.repo);
}

/** Push the branch to origin. `remoteUrl` is overridable for tests. */
export async function pushBranch(cfg: GitHubTaskConfig, dir: string, branch: string, remoteUrl: string = remoteUrlFor(cfg)): Promise<void> {
  await exec("git", ["-C", dir, ...credConfigArgs(), "push", remoteUrl, `${branch}:${branch}`], { env: gitNonInteractiveEnv() });
}

/**
 * The patch this branch adds on top of `base`, for feeding the PR-description
 * writer. Uses the three-dot form so it's the branch's own changes (not churn
 * from base moving ahead). Truncated so a huge diff can't blow the model's
 * context / cost budget. Returns "" on any error so the caller falls back to a
 * deterministic title/body.
 */
export async function branchDiff(dir: string, base: string, maxBytes = 60_000): Promise<string> {
  try {
    const { stdout } = await exec("git", ["-C", dir, "diff", "--no-color", `${base}...HEAD`], { maxBuffer: 32 * 1024 * 1024 });
    return stdout.length > maxBytes ? `${stdout.slice(0, maxBytes)}\n… (diff truncated)` : stdout;
  } catch {
    return "";
  }
}

export type MergeStatus = "clean" | "conflicts" | "error";
export interface MergeResult {
  status: MergeStatus;
  /** Repo-relative paths with unresolved conflicts (only when status === "conflicts"). */
  conflicts: string[];
}

/** Repo-relative paths currently in an unmerged (conflicted) state. */
export async function unmergedPaths(dir: string): Promise<string[]> {
  try {
    const { stdout } = await exec("git", ["-C", dir, "diff", "--name-only", "--diff-filter=U"]);
    return stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** True if the working-tree copy of `file` still carries git conflict markers. */
export function fileHasConflictMarkers(dir: string, file: string): boolean {
  try {
    const content = fs.readFileSync(path.join(dir, file), "utf8");
    return /^(<{7}|={7}|>{7})/m.test(content);
  } catch {
    return false;
  }
}

/**
 * Fetch the latest `base` from origin and merge it into the current branch, so
 * the branch is up to date before we open the PR (a PR opened against a base that
 * has moved on is what surfaces as "Unable to merge — conflicts must be resolved"
 * in the GitHub UI). On a conflict the merge is left in progress and the
 * conflicted paths returned, so the agent can resolve them in the worktree; the
 * caller then calls `completeMerge` (or `abortMerge`). `remoteUrl` is overridable
 * for tests.
 */
export async function mergeBaseIntoBranch(
  cfg: GitHubTaskConfig,
  dir: string,
  base: string,
  remoteUrl: string = remoteUrlFor(cfg),
): Promise<MergeResult> {
  try {
    await exec("git", ["-C", dir, ...credConfigArgs(), "fetch", remoteUrl, base], { env: gitNonInteractiveEnv() });
  } catch {
    return { status: "error", conflicts: [] };
  }
  try {
    await exec("git", ["-C", dir, "-c", "user.email=bivy@local", "-c", "user.name=Bivy", "merge", "--no-edit", "FETCH_HEAD"]);
    return { status: "clean", conflicts: [] };
  } catch {
    const conflicts = await unmergedPaths(dir);
    if (!conflicts.length) {
      // Non-zero exit with nothing unmerged = a real error (bad ref, etc.), not a
      // content conflict the agent can fix. Abort any half-started merge.
      await abortMerge(dir);
      return { status: "error", conflicts: [] };
    }
    return { status: "conflicts", conflicts };
  }
}

/**
 * Finish an in-progress merge after conflicts were resolved in the worktree.
 * Returns false (leaving the merge in progress) if any path is still unmerged or
 * a resolved file still contains conflict markers, so the caller can abort rather
 * than commit a broken tree. `files` is the set the agent was asked to resolve.
 */
export async function completeMerge(dir: string, files: string[] = []): Promise<boolean> {
  await exec("git", ["-C", dir, "add", "-A"]);
  if ((await unmergedPaths(dir)).length) return false;
  if (files.some((f) => fileHasConflictMarkers(dir, f))) return false;
  try {
    await exec("git", ["-C", dir, "-c", "user.email=bivy@local", "-c", "user.name=Bivy", "commit", "--no-edit"]);
    return true;
  } catch {
    return false;
  }
}

/** Abort an in-progress merge, restoring the branch to its pre-merge state. */
export async function abortMerge(dir: string): Promise<void> {
  try {
    await exec("git", ["-C", dir, "merge", "--abort"]);
  } catch {
    // no merge in progress / already clean — nothing to undo
  }
}

/**
 * Extract a `{ title, body }` PR description from a model reply, tolerating stray
 * prose or code fences around the JSON. Returns undefined if there's no usable
 * object, so the caller falls back to deterministic issue-derived text.
 */
export function parsePrContent(text: string): { title: string; body: string } | undefined {
  if (!text?.trim()) return undefined;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as { title?: unknown; body?: unknown };
    const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
    const body = typeof parsed.body === "string" ? parsed.body.trim() : "";
    if (!title && !body) return undefined;
    return { title, body };
  } catch {
    return undefined;
  }
}

export class GitHubTaskPoller {
  private timer?: NodeJS.Timeout;
  private inFlight = new Set<number>();

  constructor(
    private readonly cfg: GitHubTaskConfig,
    private readonly runTask: (issue: GitHubIssue) => Promise<void>,
    /** Node's cap on concurrently-running queue sessions (0/undefined = unlimited).
     *  Read fresh each tick so the Settings → Nodes value takes effect live. */
    private readonly maxConcurrent?: () => number,
  ) {}

  start(): void {
    // Create the pickup/claim labels up front so the user can apply them without
    // first creating them by hand (E1). Best-effort; failures only warn.
    void ensureTaskLabels(this.cfg).catch(() => {});
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.cfg.pollMs);
    this.timer.unref?.();
    console.log(`[github-tasks] polling ${this.cfg.owner}/${this.cfg.repo} for issues labelled "${this.cfg.label}" every ${Math.round(this.cfg.pollMs / 1000)}s`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    let issues: GitHubIssue[];
    try {
      issues = await listOpenLabelledIssues(this.cfg);
    } catch {
      return;
    }
    const max = this.maxConcurrent?.() ?? 0;
    const running: Promise<void>[] = [];
    for (const issue of selectActionableIssues(issues, this.cfg.claimLabel)) {
      if (this.inFlight.has(issue.number)) continue;
      // Honor the node's concurrency cap: leave the rest labelled/unclaimed so a
      // later tick (or an idle node) picks them up when a slot frees.
      if (max > 0 && this.inFlight.size >= max) break;
      // Reserve the slot synchronously (no `await` since the last check) so a
      // second issue considered later in this same loop sees an accurate
      // `inFlight.size` — then kick it off without awaiting it here (only
      // collecting the promise to await below). Awaiting a task to completion
      // before starting the next one meant the cap was never really exercised
      // within a single tick: issues ran one at a time regardless of `max`, and
      // only overlapping `setInterval` ticks happened to run more than one
      // concurrently.
      this.inFlight.add(issue.number);
      running.push(this.runIssue(issue));
    }
    await Promise.all(running);
  }

  private async runIssue(issue: GitHubIssue): Promise<void> {
    try {
      // Claim first so a restart or another node won't re-pick it.
      await addLabel(this.cfg, issue.number, this.cfg.claimLabel);
      console.log(`[github-tasks] picking up issue #${issue.number}: ${issue.title}`);
      await this.runTask(issue);
    } catch (error) {
      console.warn(`[github-tasks] issue #${issue.number} failed:`, error);
    } finally {
      this.inFlight.delete(issue.number);
    }
  }
}
