// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Universal Agent Harness — shared dependency-cache singleton.
//
// Bivy creates a git worktree per session and is NOT in the dependency-install
// path: the agent (or user) runs `npm install` / `pip install` / `cargo build`
// ad-hoc inside the worktree. Without intervention, every worktree re-downloads
// the same packages into its own tree, so N sessions of the same repo multiply
// both disk and network.
//
// When BIVY_SHARED_DEP_CACHE is set, point every package manager at ONE shared
// cache/registry directory via env, so downloads dedup across all sessions.
// These are cache/registry knobs only — they never change a project's lockfile
// or where its dependencies actually install, so the user's project tooling is
// unaffected. Opt-in, mirroring the egress-proxy singleton (see egress.ts).
//
// Note: for most ecosystems this dedups DOWNLOADS, not the installed trees
// themselves (each worktree still gets its own node_modules/target/...).
// Installed-tree dedup needs either copy-on-write worktrees or a
// base-provisioning step Bivy does not have today.
//
// pnpm is the exception, and the reason it is worth special-casing: its store is
// content-addressed and it HARDLINKS files out of the store into node_modules,
// so N worktrees sharing one store share inodes — installed-tree dedup on any
// filesystem, including the ext4/NTFS hosts where worktree-provision.ts's
// copy-on-write path correctly does nothing. Measured on this repo: a second
// worktree costs ~1.2 GB under npm and ~106 MB under pnpm.
//
// Two things that are easy to get wrong and are load-bearing here:
//   - pnpm 10+ does NOT read `npm_config_store_dir`, `PNPM_STORE_DIR`, or a
//     `store-dir=` line in .npmrc. Only `PNPM_CONFIG_STORE_DIR` (and the
//     `--store-dir` flag / `storeDir:` in pnpm-workspace.yaml) take effect, so
//     the obvious `npm_config_*` spelling used by the npm entry below would be
//     silently ignored.
//   - Hardlinks cannot cross filesystems. If the store and the worktree are on
//     different devices pnpm silently falls back to COPYING, which costs a full
//     tree per worktree PLUS a full store — strictly worse than leaving pnpm on
//     its own default store (already per-user global, so it still dedups). We
//     therefore only point pnpm at the shared store when we can confirm both
//     live on the same device; see depCacheEnv().

import fs from "node:fs";
import path from "node:path";

let cacheRoot: string | undefined;

/** Subdirectory of the shared root holding pnpm's content-addressed store. */
export const PNPM_STORE_SUBDIR = "pnpm";

/**
 * Enable the shared dep cache if BIVY_SHARED_DEP_CACHE is set. Idempotent.
 * Value "1"/"true" → a default location under the Bivy data dir; any other
 * value is treated as an explicit cache-root path. Returns the resolved root,
 * or undefined when disabled (or the root could not be created).
 */
export function initSharedDepCache(dataDir: string): string | undefined {
  if (cacheRoot) return cacheRoot;
  const flag = process.env.BIVY_SHARED_DEP_CACHE;
  if (!flag) return undefined;
  const root =
    flag === "1" || flag.toLowerCase() === "true" ? path.join(dataDir, "dep-cache") : flag;
  try {
    fs.mkdirSync(root, { recursive: true });
  } catch {
    // If we can't create the shared root, stay disabled rather than point every
    // package manager at an unwritable path (which would break installs).
    return undefined;
  }
  try {
    // Create the pnpm store eagerly so the same-device check in depCacheEnv()
    // has something to stat on the very first session, before any install has
    // run. Separate from the root above and non-fatal: if only this fails, the
    // guard just withholds the pnpm var and the other ecosystems still share.
    fs.mkdirSync(path.join(root, PNPM_STORE_SUBDIR), { recursive: true });
  } catch {
    // best effort — depCacheEnv() fails closed for pnpm on its own
  }
  cacheRoot = root;
  return cacheRoot;
}

/**
 * Env to merge into an agent/terminal subprocess so its package managers share
 * one cache, or {} when disabled. Cache/registry locations only.
 *
 * Pass the subprocess's working directory (the session worktree) so the pnpm
 * store can be checked for hardlink compatibility. When `cwd` is omitted, or it
 * is on a different filesystem than the store, the pnpm entry is dropped and
 * pnpm keeps using its own default store — see the same-device note at the top.
 */
export function depCacheEnv(cwd?: string): Record<string, string> {
  if (!cacheRoot) return {};
  const env = sharedCacheEnvFor(cacheRoot);
  if (!cwd || !sameDevice(path.join(cacheRoot, PNPM_STORE_SUBDIR), cwd)) {
    delete env.PNPM_CONFIG_STORE_DIR;
  }
  return env;
}

/**
 * True when both paths resolve onto the same filesystem, i.e. a hardlink between
 * them is possible. `cwd` may not exist yet (a worktree is created after its
 * env is composed in some paths), so walk up to the nearest existing ancestor.
 * Fails closed: any error means "assume not linkable".
 */
function sameDevice(storeDir: string, cwd: string): boolean {
  try {
    const storeDev = fs.statSync(storeDir).dev;
    let dir = path.resolve(cwd);
    for (;;) {
      try {
        return fs.statSync(dir).dev === storeDev;
      } catch {
        const parent = path.dirname(dir);
        if (parent === dir) return false; // hit the root without an existing dir
        dir = parent;
      }
    }
  } catch {
    return false;
  }
}

/**
 * Pure mapping of a cache root → per-tool cache env. Exported for tests and so
 * the mapping stays reviewable in one place. Add ecosystems here as needed
 * (Ruby GEM/bundler and Gradle change install/config location, not just cache,
 * so they are intentionally left out until validated).
 */
export function sharedCacheEnvFor(root: string): Record<string, string> {
  return {
    npm_config_cache: path.join(root, "npm"), // npm + npx download cache
    // pnpm's hardlink store — NOT npm_config_store_dir, which pnpm 10+ ignores.
    // Only emitted when it can hardlink into the worktree (see depCacheEnv).
    PNPM_CONFIG_STORE_DIR: path.join(root, PNPM_STORE_SUBDIR),
    YARN_CACHE_FOLDER: path.join(root, "yarn"), // yarn (classic) cache
    PIP_CACHE_DIR: path.join(root, "pip"), // pip wheel/download cache
    CARGO_HOME: path.join(root, "cargo"), // cargo registry + git cache
    GOMODCACHE: path.join(root, "go", "mod"), // go module cache
    GOCACHE: path.join(root, "go", "build"), // go build cache
  };
}

/** The resolved shared cache root, or undefined when disabled. */
export function sharedDepCacheRoot(): string | undefined {
  return cacheRoot;
}

/** Test-only: forget the resolved root so a fresh init can run. */
export function __resetSharedDepCacheForTests(): void {
  cacheRoot = undefined;
}
