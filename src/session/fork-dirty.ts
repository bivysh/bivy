import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ForkDirtyPatch } from "./fork.js";

/**
 * Capture / re-apply a session's UNCOMMITTED working-tree changes for a fork.
 * The committed branch already travels via origin (the destination re-clones +
 * checks it out); this carries the in-flight
 * edits on top so a fork never silently drops work-in-progress.
 *
 * The patch is size-capped. When the working tree is larger
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

/** Outcome of re-applying a fork's captured working-tree changes. */
export interface ApplyDirtyResult {
  /** True when at least part of the patch landed on the destination tree. */
  applied: boolean;
  /** True when it only landed via 3-way merge and may carry conflict markers. */
  conflicted?: boolean;
  /** A human-facing note when the patch didn't apply cleanly (or at all). */
  warning?: string;
}

/**
 * Re-apply a captured patch onto a fresh checkout at `repoDir`. A no-op when the
 * source pushed the branch instead (`pushedInstead`) or the working tree was
 * clean (empty patch). Uses `git apply` so both tracked hunks and untracked
 * new-file hunks (produced via `--no-index`) land correctly.
 *
 * NEVER throws: a fork's uncommitted changes are best-effort, and the source's
 * base commit frequently differs from what the destination cloned (a diverged
 * default branch, an unpushed source branch), so a strict `git apply` fails on
 * hunk-context mismatch and previously took the whole fork down with it. Instead
 * we fall back to `git apply --3way` (which reconstructs the hunks from the blob
 * SHAs the patch carries and merges what it can) and, when even that fails,
 * surface a warning and leave the tree as the clone left it — the fork still
 * succeeds, minus the un-appliable working-tree edits.
 */
export function applyDirtyPatch(repoDir: string, dirty: ForkDirtyPatch | undefined): ApplyDirtyResult {
  if (!dirty || dirty.pushedInstead || !dirty.patch.trim()) return { applied: false };
  const tmp = path.join(os.tmpdir(), `bivy-fork-${Date.now()}-${Math.random().toString(36).slice(2)}.patch`);
  fs.writeFileSync(tmp, dirty.patch);
  try {
    try {
      execFileSync("git", ["-C", repoDir, "apply", "--whitespace=nowarn", tmp], { stdio: "pipe" });
      return { applied: true };
    } catch {
      // Clean apply failed — the destination's base drifted from the source's.
      // Retry with a 3-way merge, which reconstructs the pre-image from the blob
      // SHAs the patch carries (present because the destination cloned the same
      // repo) and merges what it can. `git apply --3way` exits non-zero BOTH for
      // an un-appliable patch (nothing lands) AND for a conflicting one (it lands
      // the non-conflicting hunks and writes conflict markers) — so read the exit
      // status/stderr with spawnSync rather than treating every non-zero as a
      // total failure that drops all the WIP.
      const res = spawnSync("git", ["-C", repoDir, "apply", "--3way", "--whitespace=nowarn", tmp], { encoding: "utf8" });
      if (res.status === 0) return { applied: true }; // merged cleanly onto the diverged base
      const stderr = (res.stderr || "").toString();
      if (/with conflicts/i.test(stderr)) {
        return {
          applied: true,
          conflicted: true,
          warning:
            "Some uncommitted changes from the source didn't apply cleanly and were merged with conflict markers — review and resolve them in the fork.",
        };
      }
      const detail = stderr.split("\n").find((l) => l.trim()) || "patch did not apply";
      return {
        applied: false,
        warning: `Couldn't re-apply the source's uncommitted changes (${detail}); they were left behind. Re-make them in the fork if you still need them.`,
      };
    }
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // best effort
    }
  }
}
