// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Size-capped LRU eviction for regenerable caches (e.g. the shared dep cache).
//
// The shared package-manager cache (BIVY_SHARED_DEP_CACHE) grows without bound
// as sessions pull dependencies. These caches are content-addressed and
// self-healing — a package manager simply re-downloads anything missing — so it
// is safe to evict least-recently-used files to hold the cache under a byte cap.
// Best-effort: a locked/racing file is skipped, not fatal.

import fs from "node:fs";
import path from "node:path";

/** Recursive total size of the files under `dir` (symlinks not followed). */
export function dirSizeBytes(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) total += dirSizeBytes(p);
      else if (e.isFile()) total += fs.statSync(p).size;
    } catch {
      // unreadable entry — skip
    }
  }
  return total;
}

export interface EvictResult {
  before: number;
  after: number;
  removedFiles: number;
  removedBytes: number;
}

/**
 * Evict least-recently-modified files under `root` until the total size is at or
 * below `maxBytes`. No-op when already under the cap or `maxBytes <= 0`.
 */
export function evictToCap(root: string, maxBytes: number): EvictResult {
  const files: { path: string; size: number; mtimeMs: number }[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      try {
        if (e.isDirectory()) walk(p);
        else if (e.isFile()) {
          const st = fs.statSync(p);
          files.push({ path: p, size: st.size, mtimeMs: st.mtimeMs });
        }
      } catch {
        // skip
      }
    }
  };
  walk(root);

  const before = files.reduce((n, f) => n + f.size, 0);
  if (maxBytes <= 0 || before <= maxBytes) {
    return { before, after: before, removedFiles: 0, removedBytes: 0 };
  }

  files.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first = least recently used
  let total = before;
  let removedFiles = 0;
  let removedBytes = 0;
  for (const f of files) {
    if (total <= maxBytes) break;
    try {
      fs.rmSync(f.path, { force: true });
      total -= f.size;
      removedFiles += 1;
      removedBytes += f.size;
    } catch {
      // locked / racing with an install — leave it
    }
  }
  return { before, after: total, removedFiles, removedBytes };
}
