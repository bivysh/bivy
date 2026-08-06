// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Copy-on-write directory clone primitive.
//
// The foundation for installed-tree dedup across session worktrees: cloning a
// directory (e.g. a populated node_modules / target) so the copy shares blocks
// with the source until written, making the marginal disk cost of a second
// worktree ≈ its diff instead of a full duplicate.
//
// CoW is filesystem-specific and NOT portable, so we detect capability at
// runtime and ALWAYS fall back to a plain recursive copy — correct everywhere,
// just without block sharing:
//   - macOS (APFS, the default)      → clonefile via `cp -c`
//   - Linux (btrfs / XFS reflink=1 / ZFS) → reflink via `cp --reflink=always`
//   - Linux ext4, Windows NTFS, unknown   → recursive copy (no CoW)
//   - Windows ReFS/Dev Drive              → not reachable via `cp`; copy for now
//
// Detection probes the REAL mechanism on a throwaway file rather than trusting
// the filesystem name, because CoW depends on the mount, not just the OS.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type CloneStrategy = "apple-clonefile" | "reflink" | "copy";

const strategyByDir = new Map<string, CloneStrategy>();

function tryCp(args: string[]): boolean {
  try {
    return spawnSync("cp", args, { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

/**
 * Determine, once per directory, the best copy-on-write strategy the filesystem
 * backing `dir` supports. Cached per resolved directory. Falls back to "copy".
 */
export function detectCloneStrategy(dir: string = os.tmpdir()): CloneStrategy {
  const key = path.resolve(dir);
  const cached = strategyByDir.get(key);
  if (cached) return cached;
  const strategy = probeCloneStrategy(key);
  strategyByDir.set(key, strategy);
  return strategy;
}

function probeCloneStrategy(dir: string): CloneStrategy {
  const src = path.join(dir, `.bivy-cow-probe-${process.pid}-${process.hrtime.bigint()}`);
  const dst = `${src}.clone`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(src, "probe");
    if (process.platform === "darwin" && tryCp(["-c", src, dst])) return "apple-clonefile";
    if (process.platform === "linux" && tryCp(["--reflink=always", src, dst])) return "reflink";
    return "copy";
  } catch {
    return "copy";
  } finally {
    fs.rmSync(src, { force: true });
    fs.rmSync(dst, { force: true });
  }
}

/**
 * Clone directory `src` to `dst`, using copy-on-write where the destination's
 * filesystem supports it and falling back to a plain recursive copy otherwise.
 * `dst` must not already exist. Returns the strategy actually used.
 */
export function cloneDir(src: string, dst: string): CloneStrategy {
  const strategy = detectCloneStrategy(path.dirname(dst));
  if (strategy === "apple-clonefile" && tryCp(["-c", "-R", src, dst])) return "apple-clonefile";
  if (strategy === "reflink" && tryCp(["--reflink=always", "-R", src, dst])) return "reflink";
  // Universal fallback — correct on every OS/FS, no block sharing.
  fs.cpSync(src, dst, { recursive: true });
  return "copy";
}

/** Test-only: forget cached probe results. */
export function __resetCloneStrategyForTests(): void {
  strategyByDir.clear();
}
