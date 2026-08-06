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
// Note: this dedups DOWNLOADS, not the installed trees themselves (each worktree
// still gets its own node_modules/target/...). Installed-tree dedup needs either
// copy-on-write worktrees or a base-provisioning step Bivy does not have today —
// see docs/worktree-disk-strategy.md.

import fs from "node:fs";
import path from "node:path";

let cacheRoot: string | undefined;

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
  cacheRoot = root;
  return cacheRoot;
}

/**
 * Env to merge into an agent/terminal subprocess so its package managers share
 * one cache, or {} when disabled. Cache/registry locations only.
 */
export function depCacheEnv(): Record<string, string> {
  return cacheRoot ? sharedCacheEnvFor(cacheRoot) : {};
}

/**
 * Pure mapping of a cache root → per-tool cache env. Exported for tests and so
 * the mapping stays reviewable in one place. Add ecosystems here as needed
 * (Ruby GEM/bundler and Gradle change install/config location, not just cache,
 * so they are intentionally left out until validated — see the strategy doc).
 */
export function sharedCacheEnvFor(root: string): Record<string, string> {
  return {
    npm_config_cache: path.join(root, "npm"), // npm + npx download cache
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
