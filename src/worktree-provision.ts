// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
// Opportunistic installed-tree dedup for session worktrees (Approach A).
//
// Bivy creates a git worktree per session and is not in the install path, so N
// worktrees of a repo each grow their own node_modules / target / .venv. When
// the filesystem supports copy-on-write, we can instead clone an already-
// populated installed dir from a SIBLING worktree of the same repo into a fresh
// one, so its marginal disk cost is ~its diff, not a full duplicate.
//
// Safety rules baked in here:
//   - Opt-in via BIVY_WORKTREE_COW_CLONE.
//   - CoW-only: on a non-CoW filesystem we do NOTHING (a plain copy of
//     node_modules costs the same disk as a fresh install, plus time — a net
//     loss), and let the agent install normally.
//   - Only clone a dir when a sibling's lockfile fingerprint MATCHES the new
//     worktree's, so a reused install is never stale.
//   - Only these git-IGNORED installed/derived dirs — never tracked files (the
//     worktree checkout already has those).
//   - Best-effort: never throws; failure just falls back to a normal install.
//
// This is structured so a future "base-provisioning" source (Approach B) can be
// added as another candidate source without changing callers.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { detectCloneStrategy, cloneDir, type CloneStrategy } from "./harness/cow-clone.js";

interface Ecosystem {
  dir: string;
  lockfiles: string[];
}

// Order within `lockfiles` is the fingerprint precedence (first present wins).
const ECOSYSTEMS: Ecosystem[] = [
  { dir: "node_modules", lockfiles: ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "npm-shrinkwrap.json"] },
  { dir: "target", lockfiles: ["Cargo.lock"] },
  { dir: ".venv", lockfiles: ["uv.lock", "poetry.lock", "Pipfile.lock", "requirements.txt"] },
];

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Fingerprint the first present lockfile for an ecosystem, or undefined. */
function lockfileFingerprint(dir: string, lockfiles: string[]): string | undefined {
  for (const name of lockfiles) {
    try {
      const buf = fs.readFileSync(path.join(dir, name));
      return `${name}:${crypto.createHash("sha256").update(buf).digest("hex")}`;
    } catch {
      // not present — try the next
    }
  }
  return undefined;
}

function listSiblings(worktreesRoot: string, exclude: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(worktreesRoot);
  } catch {
    return [];
  }
  const excl = path.resolve(exclude);
  return entries
    .map((e) => path.join(worktreesRoot, e))
    .filter((p) => path.resolve(p) !== excl && isDir(p));
}

export interface CowPlanItem {
  dir: string;
  source: string;
}

/**
 * Decide which installed dirs the new worktree can safely reuse from a sibling.
 * Pure filesystem logic (no CoW required), so it is unit-testable everywhere.
 * For each ecosystem: skip if the new worktree already has the dir; otherwise
 * pick the first sibling that HAS the dir and whose lockfile fingerprint matches
 * the new worktree's (guaranteeing the deps are current).
 */
export function planCowProvision(opts: { worktreePath: string; worktreesRoot: string }): CowPlanItem[] {
  const siblings = listSiblings(opts.worktreesRoot, opts.worktreePath);
  const plan: CowPlanItem[] = [];
  for (const eco of ECOSYSTEMS) {
    if (isDir(path.join(opts.worktreePath, eco.dir))) continue; // never overwrite an existing install
    const destFp = lockfileFingerprint(opts.worktreePath, eco.lockfiles);
    if (!destFp) continue; // no lockfile → cannot verify freshness → skip
    for (const sib of siblings) {
      if (!isDir(path.join(sib, eco.dir))) continue;
      if (lockfileFingerprint(sib, eco.lockfiles) !== destFp) continue; // stale — different deps
      plan.push({ dir: eco.dir, source: path.join(sib, eco.dir) });
      break; // first matching sibling wins
    }
  }
  return plan;
}

export interface CowProvisionResult {
  strategy: CloneStrategy | "disabled" | "no-cow";
  cloned: string[];
}

/**
 * Opportunistically CoW-clone installed dirs into a freshly-created worktree from
 * a sibling of the same repo. Gated on BIVY_WORKTREE_COW_CLONE and on the
 * filesystem supporting copy-on-write. Best-effort; never throws.
 */
export function cowProvisionDeps(opts: {
  worktreePath: string;
  worktreesRoot: string;
  log?: (msg: string) => void;
}): CowProvisionResult {
  if (!process.env.BIVY_WORKTREE_COW_CLONE) return { strategy: "disabled", cloned: [] };
  const strategy = detectCloneStrategy(opts.worktreesRoot);
  if (strategy === "copy") return { strategy: "no-cow", cloned: [] }; // copying installed dirs is a net loss
  const cloned: string[] = [];
  for (const item of planCowProvision(opts)) {
    try {
      cloneDir(item.source, path.join(opts.worktreePath, item.dir));
      cloned.push(item.dir);
      opts.log?.(`[worktree] cow-cloned ${item.dir} from ${item.source} (${strategy})`);
    } catch (error) {
      opts.log?.(`[worktree] cow-clone of ${item.dir} skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { strategy, cloned };
}
