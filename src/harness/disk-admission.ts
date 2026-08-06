// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Disk admission control.
//
// The safe form of a hard disk cap: rather than deleting a live worktree that
// may hold uncommitted work (destructive), refuse to PROVISION new
// disk-consuming work — a fresh session worktree — when the filesystem is
// already low on free space. Bivy therefore never fills the user's device; the
// user frees space (or closes a session) and the next attempt succeeds.
//
// Opt-in via BIVY_MIN_FREE_DISK_BYTES (0/unset disables). Best-effort: if free
// space cannot be measured we ALLOW — real work must never be blocked by a
// measurement error.

import fs from "node:fs";

export interface AdmissionDecision {
  allowed: boolean;
  reason?: string;
  freeBytes?: number;
  minFreeBytes?: number;
}

export type StatfsFn = (p: string) => { bavail: number; bsize: number };

const mib = (n: number) => Math.round(n / (1024 * 1024));

function defaultStatfs(p: string): { bavail: number; bsize: number } {
  const st = fs.statfsSync(p);
  return { bavail: Number(st.bavail), bsize: Number(st.bsize) };
}

/**
 * Decide whether new disk-consuming work may be admitted on the filesystem
 * backing `pathOnFs`. `minFreeBytes` defaults to BIVY_MIN_FREE_DISK_BYTES;
 * <= 0 disables the guard (always allowed). `statfs` is injectable for tests.
 */
export function checkDiskAdmission(
  pathOnFs: string,
  opts: { minFreeBytes?: number; statfs?: StatfsFn } = {},
): AdmissionDecision {
  const minFreeBytes = opts.minFreeBytes ?? Number(process.env.BIVY_MIN_FREE_DISK_BYTES ?? 0);
  if (!Number.isFinite(minFreeBytes) || minFreeBytes <= 0) return { allowed: true };

  let freeBytes: number;
  try {
    const st = (opts.statfs ?? defaultStatfs)(pathOnFs);
    freeBytes = st.bavail * st.bsize;
  } catch {
    return { allowed: true }; // cannot measure → do not block real work
  }

  if (freeBytes < minFreeBytes) {
    return {
      allowed: false,
      freeBytes,
      minFreeBytes,
      reason: `only ${mib(freeBytes)} MiB free (need ${mib(minFreeBytes)} MiB) — free up disk, close a session, or lower BIVY_MIN_FREE_DISK_BYTES`,
    };
  }
  return { allowed: true, freeBytes, minFreeBytes };
}
