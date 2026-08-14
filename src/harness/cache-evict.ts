// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Size-capped LRU eviction for regenerable caches (e.g. the shared dep cache).
//
// The shared package-manager cache (BIVY_SHARED_DEP_CACHE) grows without bound
// as sessions pull dependencies. These caches are content-addressed and
// self-healing — a package manager simply re-downloads anything missing — so it
// is safe to evict least-recently-used files to hold the cache under a byte cap.
// Best-effort: a locked/racing file is skipped, not fatal.
//
// Exception: entries with more than one link (pnpm hardlinks its store into each
// worktree's node_modules — see dep-cache.ts) are counted toward the cap but
// never evicted, since unlinking them reclaims nothing. That means a cache made
// mostly of live hardlinks can legitimately finish a sweep still above the cap.

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
  let pinnedBytes = 0; // live hardlinked entries: counted, never evicted
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
          // A file with other links to it (pnpm's store hardlinks its entries
          // into every worktree's node_modules) is still counted toward the cap
          // — it does hold disk — but is never a candidate for removal:
          // unlinking it here frees ZERO bytes while the other links survive,
          // and it would punch a hole in pnpm's store that forces a re-download
          // on the next install. Evict the genuinely unreferenced files instead.
          if (st.nlink <= 1) files.push({ path: p, size: st.size, mtimeMs: st.mtimeMs });
          else pinnedBytes += st.size;
        }
      } catch {
        // skip
      }
    }
  };
  walk(root);

  const before = files.reduce((n, f) => n + f.size, 0) + pinnedBytes;
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
