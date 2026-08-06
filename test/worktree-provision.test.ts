// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { strict as assert } from "node:assert";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { planCowProvision, cowProvisionDeps } from "../src/worktree-provision.js";
import { cloneDir } from "../src/harness/cow-clone.js";

// Build a worktrees root with named worktrees; each spec = { lock?, hasNodeModules }.
function scaffold(specs: Record<string, { lock?: string; nodeModules?: string }>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-wt-root-"));
  for (const [name, spec] of Object.entries(specs)) {
    const wt = path.join(root, name);
    fs.mkdirSync(wt, { recursive: true });
    if (spec.lock !== undefined) fs.writeFileSync(path.join(wt, "package-lock.json"), spec.lock);
    if (spec.nodeModules !== undefined) {
      fs.mkdirSync(path.join(wt, "node_modules", "dep"), { recursive: true });
      fs.writeFileSync(path.join(wt, "node_modules", "dep", "index.js"), spec.nodeModules);
    }
  }
  return root;
}

test("plans a clone from a sibling with a matching lockfile", () => {
  const root = scaffold({
    dest: { lock: "LOCK_A" },
    sib: { lock: "LOCK_A", nodeModules: "installed" },
  });
  const plan = planCowProvision({ worktreePath: path.join(root, "dest"), worktreesRoot: root });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].dir, "node_modules");
  assert.equal(plan[0].source, path.join(root, "sib", "node_modules"));
});

test("does NOT reuse a sibling whose lockfile differs (stale deps)", () => {
  const root = scaffold({
    dest: { lock: "LOCK_A" },
    sib: { lock: "LOCK_B", nodeModules: "installed" },
  });
  assert.deepEqual(planCowProvision({ worktreePath: path.join(root, "dest"), worktreesRoot: root }), []);
});

test("skips when the new worktree already has the dir", () => {
  const root = scaffold({
    dest: { lock: "LOCK_A", nodeModules: "already-here" },
    sib: { lock: "LOCK_A", nodeModules: "installed" },
  });
  assert.deepEqual(planCowProvision({ worktreePath: path.join(root, "dest"), worktreesRoot: root }), []);
});

test("skips when the new worktree has no lockfile (freshness unverifiable)", () => {
  const root = scaffold({
    dest: {},
    sib: { lock: "LOCK_A", nodeModules: "installed" },
  });
  assert.deepEqual(planCowProvision({ worktreePath: path.join(root, "dest"), worktreesRoot: root }), []);
});

test("empty plan when no sibling has an installed dir", () => {
  const root = scaffold({ dest: { lock: "LOCK_A" }, sib: { lock: "LOCK_A" } });
  assert.deepEqual(planCowProvision({ worktreePath: path.join(root, "dest"), worktreesRoot: root }), []);
});

test("end-to-end: planned clone yields an independent copy (via cloneDir)", () => {
  const root = scaffold({
    dest: { lock: "LOCK_A" },
    sib: { lock: "LOCK_A", nodeModules: "installed" },
  });
  const dest = path.join(root, "dest");
  for (const item of planCowProvision({ worktreePath: dest, worktreesRoot: root })) {
    cloneDir(item.source, path.join(dest, item.dir));
  }
  const cloned = path.join(dest, "node_modules", "dep", "index.js");
  assert.equal(fs.readFileSync(cloned, "utf8"), "installed");
  // Independent of the source.
  fs.writeFileSync(cloned, "mutated");
  assert.equal(fs.readFileSync(path.join(root, "sib", "node_modules", "dep", "index.js"), "utf8"), "installed");
});

test("cowProvisionDeps is a no-op when the flag is unset", () => {
  const prev = process.env.BIVY_WORKTREE_COW_CLONE;
  delete process.env.BIVY_WORKTREE_COW_CLONE;
  try {
    const root = scaffold({ dest: { lock: "LOCK_A" }, sib: { lock: "LOCK_A", nodeModules: "x" } });
    const res = cowProvisionDeps({ worktreePath: path.join(root, "dest"), worktreesRoot: root });
    assert.equal(res.strategy, "disabled");
    assert.deepEqual(res.cloned, []);
  } finally {
    if (prev === undefined) delete process.env.BIVY_WORKTREE_COW_CLONE;
    else process.env.BIVY_WORKTREE_COW_CLONE = prev;
  }
});

test("cowProvisionDeps does nothing on a non-CoW filesystem even when enabled", () => {
  // CI/dev disks are typically ext4/overlay (no reflink) → strategy "copy" → skip.
  // On an APFS/reflink box this test would instead clone; assert only the
  // no-net-loss contract holds for the copy case.
  const prev = process.env.BIVY_WORKTREE_COW_CLONE;
  process.env.BIVY_WORKTREE_COW_CLONE = "1";
  try {
    const root = scaffold({ dest: { lock: "LOCK_A" }, sib: { lock: "LOCK_A", nodeModules: "x" } });
    const res = cowProvisionDeps({ worktreePath: path.join(root, "dest"), worktreesRoot: root });
    if (res.strategy === "no-cow") {
      assert.deepEqual(res.cloned, [], "non-CoW FS must not copy installed dirs");
      assert.ok(!fs.existsSync(path.join(root, "dest", "node_modules")), "no node_modules created on non-CoW");
    } else {
      // CoW filesystem: it should have cloned node_modules.
      assert.deepEqual(res.cloned, ["node_modules"]);
    }
  } finally {
    if (prev === undefined) delete process.env.BIVY_WORKTREE_COW_CLONE;
    else process.env.BIVY_WORKTREE_COW_CLONE = prev;
  }
});
