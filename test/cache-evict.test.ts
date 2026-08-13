// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { strict as assert } from "node:assert";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { dirSizeBytes, evictToCap } from "../src/harness/cache-evict.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bivy-cache-evict-"));
}

// Write a file of `size` bytes with a specific mtime (seconds since epoch).
function writeFile(p: string, size: number, mtimeSec: number) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(size, 1));
  fs.utimesSync(p, mtimeSec, mtimeSec);
}

test("dirSizeBytes sums files recursively", () => {
  const root = tmp();
  writeFile(path.join(root, "a"), 100, 1000);
  writeFile(path.join(root, "sub", "b"), 250, 1000);
  assert.equal(dirSizeBytes(root), 350);
});

test("evictToCap is a no-op when already under the cap", () => {
  const root = tmp();
  writeFile(path.join(root, "a"), 100, 1000);
  const res = evictToCap(root, 1000);
  assert.deepEqual(res, { before: 100, after: 100, removedFiles: 0, removedBytes: 0 });
});

test("evictToCap removes least-recently-modified files first until under cap", () => {
  const root = tmp();
  writeFile(path.join(root, "old"), 100, 1000); // oldest → evicted first
  writeFile(path.join(root, "mid"), 100, 2000);
  writeFile(path.join(root, "new"), 100, 3000); // newest → survives

  const res = evictToCap(root, 100); // must get down to a single 100-byte file
  assert.equal(res.before, 300);
  assert.ok(res.after <= 100, `after ${res.after} <= cap`);
  assert.equal(res.removedFiles, 2);
  assert.equal(res.removedBytes, 200);

  assert.ok(!fs.existsSync(path.join(root, "old")), "oldest evicted");
  assert.ok(!fs.existsSync(path.join(root, "mid")), "next-oldest evicted");
  assert.ok(fs.existsSync(path.join(root, "new")), "newest (MRU) kept");
});

// pnpm hardlinks its store entries into every worktree's node_modules. Unlinking
// the store copy frees nothing (the worktree link keeps the inode alive) and
// forces a re-download, so linked entries are counted but never evicted.
test("evictToCap never evicts hardlinked entries, but still counts them", () => {
  const root = tmp();
  const worktree = tmp();
  writeFile(path.join(root, "linked"), 100, 1000); // oldest — would be first to go
  fs.linkSync(path.join(root, "linked"), path.join(worktree, "in-use"));
  writeFile(path.join(root, "loose"), 100, 2000);

  const res = evictToCap(root, 100);
  assert.equal(res.before, 200, "hardlinked bytes count toward the cap");
  assert.equal(res.removedFiles, 1);
  assert.ok(fs.existsSync(path.join(root, "linked")), "hardlinked store entry survives");
  assert.ok(!fs.existsSync(path.join(root, "loose")), "unreferenced entry evicted instead");
  assert.ok(fs.existsSync(path.join(worktree, "in-use")), "the worktree link is intact");
});

// When everything left is pinned there is nothing legal to reclaim; the sweep
// must finish quietly above the cap rather than deleting live store entries.
test("evictToCap finishes above the cap when only hardlinked entries remain", () => {
  const root = tmp();
  const worktree = tmp();
  writeFile(path.join(root, "linked"), 500, 1000);
  fs.linkSync(path.join(root, "linked"), path.join(worktree, "in-use"));

  const res = evictToCap(root, 100);
  assert.equal(res.removedFiles, 0);
  assert.equal(res.after, 500, "still over cap, nothing safely reclaimable");
  assert.ok(fs.existsSync(path.join(root, "linked")));
});

test("evictToCap with maxBytes<=0 does nothing", () => {
  const root = tmp();
  writeFile(path.join(root, "a"), 100, 1000);
  assert.equal(evictToCap(root, 0).removedFiles, 0);
  assert.ok(fs.existsSync(path.join(root, "a")));
});
