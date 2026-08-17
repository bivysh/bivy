// SPDX-License-Identifier: AGPL-3.0-only
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
import { spawn, spawnSync } from "node:child_process";

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

// --- install-based provisioning (Approach B: cross-Machine, no sibling) --------
// The CoW path above only helps when a SIBLING worktree of the same repo already
// has the installed dir. On a fresh destination Machine (a cross-Machine move)
// there is no sibling, so the tree lands with no node_modules/.venv/
// target and the agent hits a cold — sometimes broken — tree on its first turn.
// This detects the project's package managers from its lockfiles and runs their
// install so the destination provisions itself. Data-driven: a new ecosystem is a
// new row, not new branching.

export interface InstallManager {
  /** Lockfile/manifest whose presence selects this manager. */
  lockfile: string;
  /** The installed/derived dir it populates ("" = no local dir, e.g. Go's global
   *  module cache — such a manager can't be skipped by a present dir). */
  dir: string;
  command: string;
  args: string[];
}

// Precedence order: the FIRST manager whose lockfile is present wins per `dir`.
export const INSTALL_MANAGERS: InstallManager[] = [
  { lockfile: "pnpm-lock.yaml", dir: "node_modules", command: "pnpm", args: ["install", "--frozen-lockfile"] },
  { lockfile: "package-lock.json", dir: "node_modules", command: "npm", args: ["ci"] },
  { lockfile: "npm-shrinkwrap.json", dir: "node_modules", command: "npm", args: ["ci"] },
  { lockfile: "yarn.lock", dir: "node_modules", command: "yarn", args: ["install", "--frozen-lockfile"] },
  { lockfile: "bun.lockb", dir: "node_modules", command: "bun", args: ["install"] },
  { lockfile: "Cargo.lock", dir: "target", command: "cargo", args: ["fetch"] },
  { lockfile: "uv.lock", dir: ".venv", command: "uv", args: ["sync"] },
  { lockfile: "poetry.lock", dir: ".venv", command: "poetry", args: ["install"] },
  { lockfile: "Pipfile.lock", dir: ".venv", command: "pipenv", args: ["install"] },
  { lockfile: "requirements.txt", dir: ".venv", command: "pip", args: ["install", "-r", "requirements.txt"] },
  { lockfile: "go.mod", dir: "", command: "go", args: ["mod", "download"] },
];

function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export interface InstallPlanItem {
  dir: string;
  command: string;
  args: string[];
  lockfile: string;
}

/**
 * Plan the installs a worktree needs to provision its deps from scratch: for each
 * ecosystem, the first manager (by precedence) whose lockfile is present AND whose
 * target dir isn't already populated. Pure filesystem logic, so it is fully
 * unit-testable. Already-provisioned dirs (a CoW clone landed, or the agent ran an
 * install already) are skipped, so this is safe to re-run.
 */
export function planInstallProvision(worktreePath: string): InstallPlanItem[] {
  const plan: InstallPlanItem[] = [];
  const claimed = new Set<string>();
  for (const m of INSTALL_MANAGERS) {
    if (m.dir && claimed.has(m.dir)) continue; // a higher-precedence manager already owns this dir
    if (!fileExists(path.join(worktreePath, m.lockfile))) continue;
    if (m.dir && isDir(path.join(worktreePath, m.dir))) { claimed.add(m.dir); continue; } // already provisioned
    plan.push({ dir: m.dir, command: m.command, args: m.args, lockfile: m.lockfile });
    if (m.dir) claimed.add(m.dir);
  }
  return plan;
}

export interface InstallProvisionResult {
  strategy: "disabled" | "ran";
  ran: string[];
  skipped: Array<{ command: string; reason: string }>;
}

/** Injectable side effects so the orchestration is unit-testable without spawning. */
export interface InstallProvisionRunner {
  /** Whether `command` is on PATH (a missing manager is skipped, not fatal). */
  has(command: string): boolean;
  /** Run one install in `cwd`; resolves on success, rejects on failure. */
  run(item: InstallPlanItem, cwd: string): Promise<void>;
}

/**
 * Provision a worktree's deps by running each detected manager's install
 * (cross-Machine fallback when CoW found no sibling). Opt-in via
 * BIVY_WORKTREE_AUTO_INSTALL. Best-effort: a missing manager is skipped and one
 * failing install never blocks the others (or the caller). The default runner
 * spawns real processes; tests inject a fake.
 */
export async function provisionDepsByInstall(
  opts: { worktreePath: string; log?: (msg: string) => void },
  runner: InstallProvisionRunner = defaultInstallRunner(),
): Promise<InstallProvisionResult> {
  if (!process.env.BIVY_WORKTREE_AUTO_INSTALL) return { strategy: "disabled", ran: [], skipped: [] };
  const ran: string[] = [];
  const skipped: Array<{ command: string; reason: string }> = [];
  for (const item of planInstallProvision(opts.worktreePath)) {
    if (!runner.has(item.command)) {
      skipped.push({ command: item.command, reason: "not on PATH" });
      opts.log?.(`[worktree] provision skipped: ${item.command} not installed (${item.lockfile})`);
      continue;
    }
    try {
      opts.log?.(`[worktree] provisioning ${item.dir || item.command} via ${item.command} ${item.args.join(" ")}`);
      await runner.run(item, opts.worktreePath);
      ran.push(item.command);
    } catch (error) {
      skipped.push({ command: item.command, reason: error instanceof Error ? error.message : String(error) });
      opts.log?.(`[worktree] provision of ${item.dir || item.command} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { strategy: "ran", ran, skipped };
}

function defaultInstallRunner(): InstallProvisionRunner {
  return {
    has(command: string): boolean {
      const probe = process.platform === "win32" ? "where" : "command";
      const args = process.platform === "win32" ? [command] : ["-v", command];
      const result = spawnSync(probe, args, { stdio: "ignore", shell: process.platform === "win32" });
      return result.status === 0;
    },
    run(item: InstallPlanItem, cwd: string): Promise<void> {
      return new Promise((resolve, reject) => {
        const child = spawn(item.command, item.args, { cwd, stdio: "ignore" });
        // Bound each install so a wedged manager can't provision forever.
        const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("install timed out")); }, INSTALL_TIMEOUT_MS);
        child.on("error", (err) => { clearTimeout(timer); reject(err); });
        child.on("exit", (code) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error(`exit ${code}`));
        });
      });
    },
  };
}

const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;

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
