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
 * Create or recover a worktree for `repoDir`, preserving existing work. It lives under
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
  let base = opts.base ?? (await currentRef(repoRoot));

  excludeMeshDir(repoRoot);
  fs.mkdirSync(root, { recursive: true });
  // Reuse the registered checkout in place. Recovery must not force-remove
  // staged, unstaged, untracked or ignored work left by the previous attempt.
  // Use Git's registry rather than merely accepting an existing directory.
  const { stdout: registered } = await exec("git", ["-C", repoRoot, "worktree", "list", "--porcelain", "-z"]);
  const existing = registered.split("\0\0").map(entry => entry.split("\0"))
    .find(fields => fields.includes(`worktree ${wtPath}`));
  if (existing && fs.existsSync(wtPath)) {
    if (!existing.includes(`branch refs/heads/${branch}`)) throw new Error(`Worktree ${wtPath} is not on expected branch ${branch}`);
    return { path: wtPath, branch, repoRoot };
  }
  // A manually reaped directory can leave a stale registration. Remove only
  // that registration, without --force (locked or newly dirty work stays safe).
  if (existing) await exec("git", ["-C", repoRoot, "worktree", "remove", wtPath]);

  // A remote-only branch does NOT make `worktree add -b` fail. Resolve it
  // before creation, otherwise a fresh Machine silently starts at default HEAD.
  const localExists = await refExists(repoRoot, `refs/heads/${branch}`);
  const remoteExists = !localExists && await refExists(repoRoot, `refs/remotes/origin/${branch}`);
  if (localExists) {
    await exec("git", ["-C", repoRoot, "worktree", "add", wtPath, branch]);
  } else {
    if (remoteExists) base = `refs/remotes/origin/${branch}`;
    else if (base !== "HEAD" && !(await refExists(repoRoot, base))) base = "HEAD";
    // Fail closed on path collisions; never delete an unrelated directory.
    await exec("git", ["-C", repoRoot, "worktree", "add", "-b", branch, wtPath, base]);
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
