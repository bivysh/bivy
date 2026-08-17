// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";

import { cowProvisionDeps, provisionDepsByInstall } from "./worktree-provision.js";

const exec = promisify(execFile);

/**
 * Git worktree isolation for a session.
 *
 * A session can optionally run in its own worktree on a fresh branch, so the
 * agent's changes are isolated and reviewable as a diff/PR rather than landing on
 * your working copy. This is OPTIONAL for manual sessions (you usually want the
 * agent in your current checkout) and REQUIRED for GitHub-issue pickup (each issue
 * gets its own branch → PR).
 *
 * Pure-ish git wrapper; no daemon state. Unit-tested in test/worktree.test.ts.
 */

export interface Worktree {
  path: string;
  branch: string;
  repoRoot: string;
}

/** Slugify arbitrary text into a safe git branch / directory segment. */
export function branchSlug(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9._/-]+/g, "-")
      .replace(/\/+/g, "-")
      .replace(/\.{2,}/g, ".")
      .replace(/-+/g, "-")
      .replace(/\.lock$/g, "")
      .replace(/^[-.]+|[-.]+$/g, "")
      .slice(0, 60) || "task"
  );
}

/** The toplevel of the git repo containing `dir`, or undefined if not a repo. */
export async function gitRepoRoot(dir: string): Promise<string | undefined> {
  try {
    const { stdout } = await exec("git", ["-C", dir, "rev-parse", "--show-toplevel"]);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function currentRef(repoRoot: string): Promise<string> {
  try {
    const { stdout } = await exec("git", ["-C", repoRoot, "rev-parse", "--abbrev-ref", "HEAD"]);
    const ref = stdout.trim();
    return ref && ref !== "HEAD" ? ref : "HEAD";
  } catch {
    return "HEAD";
  }
}

/** Keep Bivy's worktree dir out of `git status` noise without committing a rule. */
function excludeMeshDir(repoRoot: string): void {
  try {
    const excludePath = path.join(repoRoot, ".git", "info", "exclude");
    const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, "utf8") : "";
    if (!existing.split("\n").some((line) => line.trim() === ".bivy/")) {
      fs.appendFileSync(excludePath, `${existing.endsWith("\n") || !existing ? "" : "\n"}.bivy/\n`);
    }
  } catch {
    // best effort
  }
}

/**
 * Create a worktree for `repoDir` on a new branch. The worktree lives under
 * `<repoRoot>/.bivy/worktrees/<slug>` by default (excluded from git).
 */
export async function createWorktree(opts: {
  repoDir: string;
  id: string;
  branch?: string;
  base?: string;
  root?: string;
}): Promise<Worktree> {
  const repoRoot = await gitRepoRoot(opts.repoDir);
  if (!repoRoot) throw new Error(`Not a git repository: ${opts.repoDir}`);

  const slug = branchSlug(opts.id);
  const branch = opts.branch ?? `bivy/${slug}`;
  const root = opts.root ?? path.join(repoRoot, ".bivy", "worktrees");
  const wtPath = path.join(root, slug);
  const base = opts.base ?? (await currentRef(repoRoot));

  excludeMeshDir(repoRoot);
  fs.mkdirSync(root, { recursive: true });
  try {
    await exec("git", ["-C", repoRoot, "worktree", "add", "-b", branch, wtPath, base]);
  } catch (error) {
    // The branch already exists (e.g. a GitHub-issue pickup whose branch was
    // pushed on an earlier run, now re-triggered after the session closed). Adopt
    // it instead of hard-failing, which previously bubbled up and silently marked
    // the work item "done" with nothing happening. Clear any stale worktree dir
    // first, then check the existing branch out into a fresh worktree.
    const localExists = await refExists(repoRoot, `refs/heads/${branch}`);
    const remoteExists = !localExists && (await refExists(repoRoot, `refs/remotes/origin/${branch}`));
    if (localExists || remoteExists) {
      await removeWorktree(repoRoot, wtPath);
      fs.rmSync(wtPath, { recursive: true, force: true });
      if (localExists) {
        await exec("git", ["-C", repoRoot, "worktree", "add", wtPath, branch]);
      } else {
        // Recreate the local branch from origin, then check it out in the worktree.
        await exec("git", ["-C", repoRoot, "worktree", "add", "-b", branch, wtPath, `origin/${branch}`]);
      }
    } else if (base !== "HEAD" && !(await refExists(repoRoot, base))) {
      // Defense in depth for stale internal metadata: callers should resolve a
      // fork base first, but a missing ref must not prevent session stand-up.
      await removeWorktree(repoRoot, wtPath);
      fs.rmSync(wtPath, { recursive: true, force: true });
      await exec("git", ["-C", repoRoot, "worktree", "add", "-b", branch, wtPath, "HEAD"]);
    } else {
      throw error;
    }
  }

  // Opportunistically reuse a sibling worktree's installed deps (node_modules,
  // target, .venv) via copy-on-write when the filesystem supports it, so a
  // second worktree of this repo costs ~its diff instead of a full re-install.
  // Opt-in (BIVY_WORKTREE_COW_CLONE), CoW-only, lockfile-matched, best-effort.
  const cow = cowProvisionDeps({ worktreePath: wtPath, worktreesRoot: root, log: (m) => console.log(m) });

  // Cross-Machine fallback (1D): when CoW cloned nothing (fresh destination with
  // no sibling — the exact cross-Machine move case), provision the deps by running
  // the detected managers' installs so the agent doesn't hit a cold tree. Opt-in
  // (BIVY_WORKTREE_AUTO_INSTALL), background (never blocks worktree creation),
  // best-effort. `planInstallProvision` skips any dir a CoW clone already filled.
  if (cow.cloned.length === 0) {
    void provisionDepsByInstall({ worktreePath: wtPath, log: (m) => console.log(m) })
      .catch((error) => console.log(`[worktree] auto-provision error: ${error instanceof Error ? error.message : String(error)}`));
  }

  return { path: wtPath, branch, repoRoot };
}

/** True if `ref` (a fully-qualified ref) resolves in the repo. */
async function refExists(repoRoot: string, ref: string): Promise<boolean> {
  try {
    await exec("git", ["-C", repoRoot, "rev-parse", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}

/** Remove a worktree (and its branch is left intact for the PR). */
export async function removeWorktree(repoRoot: string, wtPath: string): Promise<void> {
  try {
    await exec("git", ["-C", repoRoot, "worktree", "remove", "--force", wtPath]);
  } catch {
    // already gone / not a worktree — ignore
  }
}
