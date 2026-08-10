// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Characterization tests for the branch-publish subsystem extracted from
// server.ts. The publish guard (not-yet-pushed + ahead-of-base + token → push
// once) and the branchPushed/branchPushing lifecycle had no direct coverage
// while they lived inline. createBranchPublish's injected git/GitHub primitives
// make the decision logic testable without a real repo or network.
import { strict as assert } from "node:assert";
import test from "node:test";

import { createBranchPublish, branchFromSessionName, type BranchPublishDeps, type BranchSession } from "../src/session/branch-publish.js";

function harness(over: Partial<BranchPublishDeps> = {}) {
  const pushed: Array<{ branch: string }> = [];
  const broadcasts: any[] = [];
  const deps: BranchPublishDeps = {
    broadcast: (p) => broadcasts.push(p),
    scheduleAdvertise: () => {},
    resolveTokenForRepo: async () => "tok",
    repoSessionParts: (r) => (r.worktree ? { wt: r.worktree, parsed: { owner: "o", repo: "r", slug: "o/r" } } : undefined),
    gitAheadCount: () => 3,
    resolveDefaultBaseRef: async () => "origin/main",
    pushBranch: async (_cfg, _cwd, branch) => { pushed.push({ branch }); },
    ...over,
  };
  return { deps, pushed, broadcasts, bp: createBranchPublish(deps) };
}

const withWorktree = (over: Partial<BranchSession> = {}): BranchSession => ({
  id: "s1",
  worktree: { path: "/wt", branch: "bivy/feature-abc123", repoRoot: "/repo" },
  ...over,
});

test("branchFromSessionName slugs the name and reuses a prior 6-hex suffix", () => {
  assert.equal(branchFromSessionName("Add Login", "bivy/old-name-deadbe"), "bivy/add-login-deadbe");
});

test("publishes once when the branch is ahead and a token exists", async () => {
  const { bp, pushed, broadcasts } = harness();
  const record = withWorktree();
  await bp.maybePushWorktreeBranch(record);
  assert.deepEqual(pushed.map((p) => p.branch), ["bivy/feature-abc123"]);
  assert.equal(record.branchPushed, true);
  assert.equal(record.branchPushing, false, "re-entry guard cleared in finally");
  assert.ok(broadcasts.some((b) => b.type === "session.notice"));
});

test("does not publish when there are no commits ahead of base", async () => {
  const { bp, pushed } = harness({ gitAheadCount: () => 0 });
  const record = withWorktree();
  await bp.maybePushWorktreeBranch(record);
  assert.deepEqual(pushed, [], "nothing to publish");
  assert.equal(record.branchPushed, undefined);
});

test("does not publish without a token, and leaves the branch retryable", async () => {
  const { bp, pushed } = harness({ resolveTokenForRepo: async () => undefined });
  const record = withWorktree();
  await bp.maybePushWorktreeBranch(record);
  assert.deepEqual(pushed, []);
  assert.equal(record.branchPushed, undefined, "not marked pushed → a later turn retries");
  assert.equal(record.branchPushing, false);
});

test("already-published branch is a no-op (no second push)", async () => {
  const { bp, pushed } = harness();
  const record = withWorktree({ branchPushed: true });
  await bp.maybePushWorktreeBranch(record);
  assert.deepEqual(pushed, []);
});

test("a non-repo session never publishes", async () => {
  const { bp, pushed } = harness();
  const record: BranchSession = { id: "s2" };
  await bp.maybePushWorktreeBranch(record);
  assert.deepEqual(pushed, []);
});

test("maybeRenameWorktreeBranch is a no-op once the branch is published", () => {
  const { bp, broadcasts } = harness();
  const record = withWorktree({ branchPushed: true });
  const before = record.worktree!.branch;
  bp.maybeRenameWorktreeBranch(record, "New Title");
  assert.equal(record.worktree!.branch, before, "published branch is never renamed (would orphan upstream)");
  assert.deepEqual(broadcasts, []);
});
