// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { resolveSecret } from "./secrets.js";
import { cleanRemoteUrl, credConfigArgs, gitNonInteractiveEnv, configureRepoCredentialHelper } from "./git-auth.js";

const exec = promisify(execFile);

/**
 * Start a session on a GitHub repo: clone it into a local git workspace (once per
 * repo, reused after) so the agent works in a real checkout. Pairs with the
 * autonomy boundary (writes confined to the clone) and the existing worktree/PR
 * flow. Token auth is used when available (private repos); public repos clone
 * without one. Args are passed to git via execFile (no shell), so a validated
 * `owner/repo` is safe from injection.
 */

export interface ParsedRepo {
  owner: string;
  repo: string;
  slug: string;
}

/** Parse "owner/repo" (also tolerates a full github.com URL or trailing .git). */
export function parseRepo(input: string): ParsedRepo | undefined {
  const cleaned = String(input)
    .trim()
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/^git@github\.com:/i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  const m = cleaned.match(/^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/);
  return m ? { owner: m[1], repo: m[2], slug: `${m[1]}/${m[2]}` } : undefined;
}

/** Parse a GitHub owner/repo slug from a git remote URL. */
export function parseGitHubRemote(input: string): ParsedRepo | undefined {
  const value = String(input).trim();
  const https = value.match(/^https?:\/\/(?:[^/@]+(?::[^/@]*)?@)?github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (https) return parseRepo(`${https[1]}/${https[2]}`);
  const ssh = value.match(/^(?:ssh:\/\/)?git@github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (ssh) return parseRepo(`${ssh[1]}/${ssh[2]}`);
  return undefined;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A git failure that DEFINITIVELY means "this workspace is not a GitHub-connected
 * checkout" — a genuine `undefined` answer — as opposed to a transient failure we
 * must not mistake for one. `git remote get-url origin` reports "not a git
 * repository" (no repo) or "No such remote" (a repo with no origin); both are
 * real, stable answers. Anything else (notably `index.lock`/`config.lock`
 * contention when many sessions touch the same shared clone at once) is transient.
 */
function isDefinitiveNonGitHubError(error: unknown): boolean {
  const e = error as { stderr?: string; message?: string } | undefined;
  const text = `${e?.stderr ?? ""} ${e?.message ?? String(error)}`;
  return /not a git repository|No such remote|does not appear to be a git repository/i.test(text);
}

/**
 * Infer owner/repo from a workspace's origin remote, if it is a GitHub checkout.
 *
 * Retries transient git failures before giving up. Misclassifying a momentarily
 * busy GitHub checkout as "not a repo" is what let a session skip worktree
 * isolation and run directly in the shared clone root, where its `git
 * checkout`/`git stash` collided with a concurrent session (the "sessions
 * mixing" bug). So: a DEFINITIVE non-GitHub result (not a repo / no origin)
 * resolves to `undefined` as before, but a transient error is retried and then
 * THROWN — the caller must fail loudly rather than silently degrade to running
 * the agent in the shared root.
 */
export async function inferGitHubRepoFromWorkspace(workspace: string): Promise<ParsedRepo | undefined> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { stdout } = await exec("git", ["-C", workspace, "remote", "get-url", "origin"], { cwd: workspace });
      return parseGitHubRemote(stdout);
    } catch (error) {
      if (isDefinitiveNonGitHubError(error)) return undefined;
      lastError = error;
      if (attempt < 2) await delay(50 * (attempt + 1));
    }
  }
  throw new Error(
    `Could not determine the GitHub repo for ${workspace} (the checkout may be busy): ` +
      `${(lastError as Error)?.message ?? String(lastError)}`,
  );
}

/**
 * True when `dir` is a Bivy-managed shared clone root — a direct child of the
 * repos root, i.e. `<reposRoot>/owner__repo` (see `cloneOrUpdateRepo`). Every
 * session for a repo shares that one checkout, so an agent must NEVER run
 * directly in it; it runs in a per-session worktree instead. Worktree paths live
 * DEEPER (`<clone>/.bivy/worktrees/<slug>`) and are intentionally not matched, so
 * this cleanly distinguishes "the shared root" from "an isolated worktree".
 */
export function isSharedCloneRoot(dir: string, reposRoot: string): boolean {
  return path.resolve(path.dirname(path.resolve(dir))) === path.resolve(reposRoot);
}

/** A GitHub token from env or the local `gh` login, or undefined (public only). */
export async function resolveGitHubToken(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const fromEnv = env.BIVY_GITHUB_TOKEN?.trim();
  if (fromEnv) {
    if (fromEnv.startsWith("secret://") || fromEnv.startsWith("op://") || fromEnv.startsWith("env://")) return resolveSecret(fromEnv);
    return fromEnv;
  }
  try {
    const { stdout } = await exec("gh", ["auth", "token"]);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether the GitHub CLI (`gh`) is installed on this machine — used only to
 * shade the "no GitHub token" message: when `gh` is present but `gh auth token`
 * gave us nothing, the user is one `gh auth login` away, so the picker can say
 * so. It never means `gh` is REQUIRED — `bivy github:connect` is the primary
 * path and needs no CLI (see resolveGitHubToken). Mirrors the `command -v`
 * probe in secrets.ts.
 */
export async function ghCliInstalled(): Promise<boolean> {
  const which = process.platform === "win32" ? "where" : "command";
  const args = process.platform === "win32" ? ["gh"] : ["-v", "gh"];
  try {
    await exec(which, args, process.platform === "win32" ? {} : ({ shell: true } as never));
    return true;
  } catch {
    return false;
  }
}

/**
 * Refresh the remote-tracking refs so a session branches off the CURRENT state
 * of `origin`, not whatever the local checkout last saw. Best-effort: an offline
 * node (or a checkout with no reachable origin) keeps its existing refs and the
 * caller branches off those. `cloneOrUpdateRepo` already fetches on the clone
 * path, so this is for the "workspace is an existing local checkout" path, which
 * otherwise never pulls the latest origin before cutting a branch.
 */
export async function fetchOrigin(repoDir: string): Promise<void> {
  try {
    await exec("git", ["-C", repoDir, "fetch", "origin", "--prune"], { cwd: repoDir, timeout: 120_000 });
  } catch {
    // offline / no origin / no rights — branch off the refs we already have.
  }
}

/**
 * Resolve the ref a new branch should be cut from: the remote's default branch
 * (`origin/main`, `origin/master`, …). Falls back to `origin/main` when the
 * remote HEAD isn't recorded. Used so a repo-backed session branches off the
 * upstream default rather than whatever the shared checkout happens to be on.
 */
export async function resolveDefaultBaseRef(repoDir: string): Promise<string> {
  // origin/HEAD points at the remote's default branch when it's been recorded.
  try {
    const { stdout } = await exec("git", ["-C", repoDir, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: repoDir });
    const ref = stdout.trim();
    if (ref) return ref; // e.g. "origin/main"
  } catch {
    // origin/HEAD is often unset on a fresh clone — record it, then retry.
  }
  try {
    await exec("git", ["-C", repoDir, "remote", "set-head", "origin", "--auto"], { cwd: repoDir });
    const { stdout } = await exec("git", ["-C", repoDir, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: repoDir });
    const ref = stdout.trim();
    if (ref) return ref;
  } catch {
    // best effort
  }
  return "origin/main";
}

/**
 * Resolve the ref to branch a new session from when the caller (the composer's
 * branch pill) requested a SPECIFIC remote branch instead of the repo's
 * default. `cloneOrUpdateRepo`/`fetchOrigin` have already brought every remote
 * branch's tracking ref down before this runs, so this only needs to verify
 * `origin/<branch>` actually exists — surfacing a clear error instead of
 * silently falling back to the default when the requested branch is missing
 * (e.g. typo'd, deleted upstream since the picker's list was fetched).
 */
export async function resolveBranchBaseRef(repoDir: string, branch: string): Promise<string> {
  const ref = `origin/${branch}`;
  try {
    await exec("git", ["-C", repoDir, "rev-parse", "--verify", "--quiet", ref], { cwd: repoDir });
    return ref;
  } catch {
    throw new Error(`Branch "${branch}" was not found on the remote.`);
  }
}

/**
 * Base ref for ADOPTING a source branch onto a fresh clone on another node (a
 * cross-node fork). Prefers the pushed `origin/<branch>` so the source's
 * committed work travels; falls back to the repo's default branch when the
 * source branch was never pushed (best-effort — any uncommitted work still
 * arrives via the fork's dirty patch). Fetches first so `origin/<branch>` is
 * current. Contrast with `resolveBranchBaseRef`, which is user-facing and throws
 * on a missing branch; a fork must degrade rather than fail.
 */
export async function resolveAdoptBaseRef(repoDir: string, branch: string): Promise<string> {
  await fetchOrigin(repoDir);
  try {
    await exec("git", ["-C", repoDir, "rev-parse", "--verify", "--quiet", `origin/${branch}`], { cwd: repoDir });
    return `origin/${branch}`;
  } catch {
    return resolveDefaultBaseRef(repoDir);
  }
}

/**
 * Whether an existing Bivy-owned checkout at `dest` can be reused as-is, i.e. it
 * has a `.git` entry AND `git rev-parse` accepts it as a real repository. A
 * `.git` can survive an interrupted/corrupt clone, so presence alone is not
 * enough — callers that reuse on presence alone hand a broken directory to the
 * worktree flow, which then fails with "Not a git repository". Exported for
 * tests.
 */
export async function isReusableCheckout(dest: string): Promise<boolean> {
  if (!fs.existsSync(path.join(dest, ".git"))) return false;
  try {
    await exec("git", ["-C", dest, "rev-parse", "--show-toplevel"], { cwd: dest });
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure a working clone of the repo exists under `root` and return its path.
 * Clones on first use; on later use fetches the latest. One checkout per repo.
 */
// The remote URL is now token-free — auth goes through the daemon credential
// helper (see src/git-auth.ts), so no token is written into `.git/config`.
// Still tighten `.git/config` to 0600 (git writes it 0644 by default): it holds
// the credential-helper config and other local settings, and a least-readable
// posture is cheap insurance. Best-effort.
function hardenGitConfigPerms(dest: string): void {
  try {
    fs.chmodSync(path.join(dest, ".git", "config"), 0o600);
  } catch {
    // no .git/config yet, or a filesystem without POSIX modes — ignore
  }
}

export async function cloneOrUpdateRepo(opts: { owner: string; repo: string; token?: string; root: string }): Promise<string> {
  const dest = path.join(opts.root, `${opts.owner}__${opts.repo}`);
  // Keep the remote URL token-free; auth flows through the daemon credential
  // helper (see src/git-auth.ts), which fetches a fresh token on demand — so no
  // token is written into this clone's `.git/config`, where an agent (or
  // `git remote -v` / a log / a screenshot) could read it.
  const url = cleanRemoteUrl(opts.owner, opts.repo);
  const env = gitNonInteractiveEnv();
  const cc = credConfigArgs();

  // Reuse the existing checkout only if it is a REAL git repository. A `.git`
  // entry can survive a clone that was interrupted (network drop, killed
  // process) or otherwise left corrupt — the directory exists and has a `.git`,
  // but `git rev-parse` rejects it. Trusting `.git`'s mere presence took the
  // fetch path and returned that broken directory, so every later "new session
  // on this repo" failed downstream in createWorktree with "Not a git
  // repository" — permanently, because the wipe-and-reclone repair below only
  // ran when `.git` was entirely absent. Validate first; if it's broken, fall
  // through and rebuild it.
  if (await isReusableCheckout(dest)) {
    try {
      // Rewrite origin to the clean URL. This also MIGRATES any pre-existing
      // clone whose remote still carries an embedded token from before this fix.
      await exec("git", ["-C", dest, "remote", "set-url", "origin", url], { cwd: dest });
      await configureRepoCredentialHelper((a) => exec("git", a, { cwd: dest }), dest);
      await exec("git", ["-C", dest, ...cc, "fetch", "--all", "--prune"], { cwd: dest, timeout: 120_000, env });
      // Re-point origin/HEAD at the remote's CURRENT default branch. Without
      // this a cached checkout keeps whatever default it recorded at first
      // clone, so if the repo's default later changed (e.g. main → master) a new
      // session would branch off the stale remote default. --auto is best-effort
      // and only rewrites the local origin/HEAD pointer, never a branch.
      await exec("git", ["-C", dest, "remote", "set-head", "origin", "--auto"], { cwd: dest });
    } catch {
      // offline / fetch failed — reuse the existing checkout as-is
    }
    hardenGitConfigPerms(dest);
    return dest;
  }

  fs.mkdirSync(opts.root, { recursive: true });
  // A failed/interrupted/corrupt clone can leave a non-repository (or broken
  // repository) directory behind; because this path is Bivy-owned
  // (<root>/<owner>__<repo>), repair it instead of letting every later "new repo
  // session" fail with "destination exists" or "Not a git repository".
  if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
  // Always give child_process a real cwd. The daemon may still be serving while
  // an npm-global update atomically replaces its install directory; inheriting
  // that now-unlinked cwd makes git abort before it can even process `clone`
  // ("Unable to read current working directory"). The repos root is durable
  // across package updates and was created immediately above.
  await exec("git", [...cc, "clone", url, dest], { cwd: opts.root, timeout: 600_000, env });
  // Persist the helper config so agent-run git in this clone authenticates too.
  // These follow-up processes need an explicit cwd for the same reason.
  await configureRepoCredentialHelper((a) => exec("git", a, { cwd: dest }), dest);
  hardenGitConfigPerms(dest);
  return dest;
}
