import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ForkDirtyPatch } from "./fork.js";

/**
 * Capture / re-apply a session's UNCOMMITTED working-tree changes for a fork
 * (see docs/session-fork-plan.md). The committed branch already travels via
 * origin (the destination re-clones + checks it out); this carries the in-flight
 * edits on top so a fork never silently drops work-in-progress.
 *
 * Resolved decision: the patch is size-capped. When the working tree is larger
 * than the cap (big or binary churn), we DON'T inline it — `capture` returns
 * `pushedInstead: true` and the caller commits & pushes the branch so the
 * destination reproduces from the pushed commit instead.
 */

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024; // 5 MiB of patch text

function git(repoDir: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", repoDir, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    // `git diff --no-index` exits 1 when files differ — that's the normal case,
    // and the useful patch is on stdout, so surface it rather than throwing.
    const e = err as { status?: number; stdout?: string };
    if (typeof e.stdout === "string") return e.stdout;
    throw err;
  }
}

/**
 * Snapshot the working tree at `repoDir`: tracked changes vs HEAD plus untracked
 * (non-ignored) files, as a single `git apply`-able patch. Returns
 * `pushedInstead: true` (and an empty patch) when the snapshot exceeds `maxBytes`.
 */
export function captureDirtyPatch(repoDir: string, opts: { maxBytes?: number } = {}): ForkDirtyPatch {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  // Tracked changes relative to HEAD (staged + unstaged), binary-safe.
  const tracked = git(repoDir, ["diff", "HEAD", "--binary"]);
  const untracked = git(repoDir, ["ls-files", "--others", "--exclude-standard"])
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  // Each untracked file becomes a "new file" patch via --no-index against /dev/null.
  const untrackedPatches = untracked.map((rel) =>
    git(repoDir, ["diff", "--no-index", "--binary", "--", "/dev/null", rel]),
  );
  const patch = [tracked, ...untrackedPatches].filter(Boolean).join("");
  if (Buffer.byteLength(patch, "utf8") > maxBytes) {
    return { patch: "", untracked: [], pushedInstead: true };
  }
  return { patch, untracked };
}

/**
 * Re-apply a captured patch onto a fresh checkout at `repoDir`. A no-op when the
 * source pushed the branch instead (`pushedInstead`) or the working tree was
 * clean (empty patch). Uses `git apply` so both tracked hunks and untracked
 * new-file hunks (produced via `--no-index`) land correctly.
 */
export function applyDirtyPatch(repoDir: string, dirty: ForkDirtyPatch | undefined): void {
  if (!dirty || dirty.pushedInstead || !dirty.patch.trim()) return;
  const tmp = path.join(os.tmpdir(), `bivy-fork-${Date.now()}-${Math.random().toString(36).slice(2)}.patch`);
  fs.writeFileSync(tmp, dirty.patch);
  try {
    execFileSync("git", ["-C", repoDir, "apply", "--whitespace=nowarn", tmp], { stdio: "pipe" });
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // best effort
    }
  }
}
