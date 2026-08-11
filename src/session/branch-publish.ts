// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Worktree branch publishing + renaming, extracted from server.ts. Owns the
// branchPushed/branchPushing lifecycle flags and everything that mutates a
// session's worktree branch: publishing it to origin on first commit, pushing a
// fork's source branch before a cross-node bundle, and renaming the local branch
// to track the session title.
//
// Operates on a NARROW session shape (BranchSession) and reaches the daemon only
// through the injected BranchPublishDeps; the git/GitHub primitives it needs are
// imported directly. SessionRecord structurally satisfies BranchSession.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { GitHubTaskConfig } from "../github-tasks.js";
import { branchSlug } from "../worktree.js";

/** Only the session fields branch publishing reads or writes. `worktree.branch`
 *  is mutated in place by the rename. */
export interface BranchSession {
  id: string;
  worktree?: { path: string; branch: string; repoRoot: string };
  branchPushed?: boolean;
  branchPushing?: boolean;
}

/** The repo-backed slice repoSessionParts returns — structural so this module
 *  needn't import the server's Worktree/ParsedRepo types. */
interface RepoParts {
  wt: { path: string; branch: string; repoRoot: string };
  parsed: { owner: string; repo: string; slug: string };
}

export interface BranchPublishDeps {
  broadcast(payload: unknown): void;
  scheduleAdvertise(): void;
  resolveTokenForRepo(owner: string, repo: string): Promise<string | undefined>;
  repoSessionParts(record: BranchSession): RepoParts | undefined;
  /** Commits on HEAD ahead of `base` in `cwd` — a shared git helper (also used
   *  by the issue-task paths), so it stays server-side and is injected. */
  gitAheadCount(base: string, cwd: string): number;
  /** origin's default branch ref for the repo at `repoRoot`. */
  resolveDefaultBaseRef(repoRoot: string): Promise<string>;
  /** Push `branch` from `cwd` to origin using the task config. */
  pushBranch(cfg: GitHubTaskConfig, cwd: string, branch: string): Promise<unknown>;
}

export interface BranchPublish {
  maybePushWorktreeBranch(record: BranchSession): Promise<void>;
  pushForkSourceBranch(record: BranchSession): Promise<void>;
  maybeRenameWorktreeBranch(record: BranchSession, name: string): void;
}

/** The canonical GitHub task config for Bivy-managed repos. */
function bivyGitHubConfig(token: string, owner: string, repo: string, repoDir: string): GitHubTaskConfig {
  return { token, owner, repo, repoDir, label: "bivy", claimLabel: "bivy:in-progress", pollMs: 60_000 };
}

/** Derive `bivy/<slug>-<6hex>` from a session name, reusing a prior 6-hex suffix
 *  so a rename keeps the branch's stable id. */
export function branchFromSessionName(name: string, previousBranch?: string): string {
  const suffix = previousBranch?.match(/-([0-9a-f]{6})$/i)?.[1] ?? randomBytes(3).toString("hex");
  return `bivy/${branchSlug(name || "session")}-${suffix}`;
}

export function createBranchPublish(deps: BranchPublishDeps): BranchPublish {
  /**
   * Publish a repo-backed session's worktree branch to the remote on its first
   * commit, so the work shows up on GitHub (and the branch has an upstream for
   * later pushes). Idempotent: no-op until the branch is ahead of origin's default
   * branch, and pushes only once per session. Best-effort — a failure (offline,
   * no token, no push rights) just leaves the branch local and retries next turn.
   */
  async function maybePushWorktreeBranch(record: BranchSession): Promise<void> {
    const parts = deps.repoSessionParts(record);
    if (!parts || record.branchPushed || record.branchPushing) return;
    const { wt, parsed } = parts;

    record.branchPushing = true; // synchronous re-entry guard across turns
    try {
      const base = await deps.resolveDefaultBaseRef(wt.repoRoot);
      if (deps.gitAheadCount(base, wt.path) <= 0) return; // no commits yet — nothing to publish

      const token = await deps.resolveTokenForRepo(parsed.owner, parsed.repo);
      if (!token) return; // can't push without a token; the branch stays local

      const cfg = bivyGitHubConfig(token, parsed.owner, parsed.repo, wt.repoRoot);
      await deps.pushBranch(cfg, wt.path, wt.branch);
      record.branchPushed = true;
      deps.broadcast({ type: "session.notice", sessionId: record.id, message: `Published branch ${wt.branch} to ${parsed.slug}.` });
      deps.scheduleAdvertise();
    } finally {
      record.branchPushing = false;
    }
  }

  /**
   * Push a fork's SOURCE branch to origin before a cross-node bundle leaves, so
   * committed work can reach the destination node. Best-effort: offline / no
   * rights / a protected branch just leaves it local and the fork proceeds from
   * the best available base.
   */
  async function pushForkSourceBranch(record: BranchSession): Promise<void> {
    const parts = deps.repoSessionParts(record);
    if (!parts) return;
    const { wt, parsed } = parts;
    try {
      const token = await deps.resolveTokenForRepo(parsed.owner, parsed.repo);
      if (!token) return;
      const cfg = bivyGitHubConfig(token, parsed.owner, parsed.repo, wt.repoRoot);
      await deps.pushBranch(cfg, wt.path, wt.branch);
      record.branchPushed = true;
    } catch {
      // offline / no rights / protected branch — committed work may not reach a
      // cross-node destination, but the fork still proceeds from the best base.
    }
  }

  /** Rename the worktree's local branch to track a new session title. No-op once
   *  the branch has been published (a rename would orphan the upstream) or while a
   *  push is in flight. */
  function maybeRenameWorktreeBranch(record: BranchSession, name: string): void {
    const wt = record.worktree;
    if (!wt || record.branchPushed || record.branchPushing) return;
    const next = branchFromSessionName(name, wt.branch);
    if (!next || next === wt.branch) return;

    const result = spawnSync("git", ["-C", wt.path, "branch", "-m", wt.branch, next], { encoding: "utf8", timeout: 10_000 });
    if (result.error || result.status !== 0) {
      const detail = String(result.stderr || result.error || "git branch rename failed").trim();
      // Pass the branch names as args, not spliced into the format string: a branch
      // name containing a %-specifier would otherwise be interpreted by console.warn
      // (CodeQL js/tainted-format-string).
      console.warn("[branch-rename] could not rename %s to %s:", wt.branch, next, detail);
      return;
    }

    wt.branch = next;
    deps.broadcast({ type: "session.branch_renamed", sessionId: record.id, branch: next });
  }

  return { maybePushWorktreeBranch, pushForkSourceBranch, maybeRenameWorktreeBranch };
}
