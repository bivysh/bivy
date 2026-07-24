// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
//
// Ship a session's git checkpoint between the owner node's repo and a standby's
// replica repo as a git BUNDLE (docs/session-replication.md, worktree sync).
//
// The harness records each turn's checkpoint as a commit under the private ref
// `refs/bivy/checkpoints/<slug>` (src/harness/checkpoint.ts). To replicate the
// workspace we move those commits — nothing else — to the standby:
//
//   owner:   git bundle create <tmp> [<sinceSha>..]<ref>   → bytes over the wire
//   standby: git fetch <tmp> <ref>:<ref>                    → objects land locally
//            git read-tree <ref> && git checkout-index -a -f → materialize worktree
//
// A bundle is a self-contained, verifiable pack: when `sinceSha` is given it is a
// THIN bundle carrying only the new commits (the standby already holds the base),
// falling back to a FULL bundle when the standby has nothing or its base is gone.
// If a thin bundle's prerequisite is missing on the standby, `applyCheckpointBundle`
// reports `needFull` so the owner re-sends a full one — the same self-healing shape
// as the transcript cursor.
//
// Kept dependency-light (just `git` + a temp file) and unit-tested against real
// repos (test/checkpoint-pack.test.ts).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const exec = promisify(execFile);

const IDENTITY_ENV = {
  GIT_AUTHOR_NAME: "Bivy Harness",
  GIT_AUTHOR_EMAIL: "harness@bivy.local",
  GIT_COMMITTER_NAME: "Bivy Harness",
  GIT_COMMITTER_EMAIL: "harness@bivy.local",
} as const;

/** The private checkpoint ref for a session (mirrors CheckpointStore.slugRef). */
export function checkpointRef(sessionId: string): string {
  const slug = sessionId.replace(/[^A-Za-z0-9._-]/g, "-");
  return `refs/bivy/checkpoints/${slug}`;
}

function git(cwd: string, args: string[]) {
  return exec("git", ["-C", cwd, ...args], {
    env: { ...process.env, ...IDENTITY_ENV },
    maxBuffer: 256 * 1024 * 1024,
  });
}

async function withTempFile<T>(fn: (file: string) => Promise<T>): Promise<T> {
  const file = path.join(os.tmpdir(), `bivy-ckpt-${randomUUID()}.bundle`);
  try {
    return await fn(file);
  } finally {
    await fs.promises.rm(file, { force: true });
  }
}

/**
 * Build a bundle carrying the session's checkpoint commit(s). Returns the bundle
 * bytes, or `null` when there is nothing to send (no checkpoint ref yet, or the
 * standby is already at the tip so an incremental range would be empty).
 *
 * @param repoDir   the owner's worktree (any path inside the repo)
 * @param sessionId the session whose checkpoint ref to bundle
 * @param sinceSha  the standby's last-known checkpoint sha; when it is an ancestor
 *                  of the current tip, only the delta is bundled (thin)
 */
export async function createCheckpointBundle(
  repoDir: string,
  sessionId: string,
  sinceSha?: string,
): Promise<Buffer | null> {
  const ref = checkpointRef(sessionId);
  // No checkpoint ref → nothing to replicate yet.
  const tip = await git(repoDir, ["rev-parse", "--verify", "--quiet", ref]).then((r) => r.stdout.trim()).catch(() => "");
  if (!tip) return null;
  // Already current — skip an empty bundle.
  if (sinceSha && sinceSha === tip) return null;
  // Use a thin range only when `sinceSha` is a real ancestor we can negate against.
  let range = ref;
  if (sinceSha) {
    const isAncestor = await git(repoDir, ["merge-base", "--is-ancestor", sinceSha, ref]).then(() => true).catch(() => false);
    if (isAncestor) range = `${sinceSha}..${ref}`;
  }
  return withTempFile(async (file) => {
    try {
      await git(repoDir, ["bundle", "create", file, range]);
    } catch {
      // An empty range ("Refusing to create empty bundle") or any bundle failure
      // → nothing to ship.
      return null;
    }
    return fs.promises.readFile(file);
  });
}

export type ApplyBundleResult = { ok: true } | { ok: false; needFull: true };

/**
 * Apply a checkpoint bundle into the standby's replica repo, advancing its
 * checkpoint ref. Returns `{ ok:false, needFull:true }` when the bundle is thin
 * and its prerequisite base commit is missing locally, so the caller can request
 * a full bundle. Does NOT touch the working tree — call `materializeCheckpoint`
 * for that once the objects are present.
 */
export async function applyCheckpointBundle(
  replicaDir: string,
  sessionId: string,
  bundle: Buffer,
): Promise<ApplyBundleResult> {
  const ref = checkpointRef(sessionId);
  return withTempFile(async (file) => {
    await fs.promises.writeFile(file, bundle);
    // A thin bundle with an absent prerequisite fails verification here.
    const verified = await git(replicaDir, ["bundle", "verify", file]).then(() => true).catch(() => false);
    if (!verified) return { ok: false, needFull: true };
    await git(replicaDir, ["fetch", file, `${ref}:${ref}`]);
    return { ok: true };
  });
}

/**
 * Materialize the standby's checkpoint ref into its replica working tree, so a
 * promoted session continues from the exact files of the last replicated turn.
 * Uses a throwaway index and force checkout — the replica worktree is ours to own.
 */
export async function materializeCheckpoint(replicaDir: string, sessionId: string): Promise<void> {
  const ref = checkpointRef(sessionId);
  const tmpIndex = path.join(os.tmpdir(), `bivy-ckpt-index-${randomUUID()}`);
  try {
    const withIndex = (args: string[]) =>
      exec("git", ["-C", replicaDir, ...args], {
        env: { ...process.env, ...IDENTITY_ENV, GIT_INDEX_FILE: tmpIndex },
        maxBuffer: 256 * 1024 * 1024,
      });
    await withIndex(["read-tree", ref]);
    await withIndex(["checkout-index", "-a", "-f"]);
  } finally {
    await fs.promises.rm(tmpIndex, { force: true });
  }
}
