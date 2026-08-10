// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Characterization tests for the PR-detection engine extracted from server.ts.
// The reconcile merge (branch PRs + harvested numbers + previously-known PRs,
// deduped by URL, open-first sort) and the change-detection/persist path had no
// direct coverage while they lived inline. createPrDetection's narrow deps —
// including the two injected GitHub lookups — let us drive them with fakes.
import { strict as assert } from "node:assert";
import test from "node:test";

import { createPrDetection, reconcilePrsAgainstGitHub, sortPrs, type PrDetectionDeps, type PrLookups, type PrSession } from "../src/session/pr-detection.js";

const cfg = { token: "t", owner: "o", repo: "r", repoDir: "/x", label: "bivy", claimLabel: "bivy:in-progress", pollMs: 60_000 } as any;
const pr = (over: any = {}) => ({ url: `https://github.com/o/r/pull/${over.number ?? 1}`, number: over.number ?? 1, state: over.state ?? "open", ...over });

/** Fake GitHub lookups: branch PRs from a fixed list, by-number returns a PR
 *  whose state comes from `stateOf` (default merged) so "re-fetch reflects a
 *  merge/close" is observable. */
function fakeLookups(branchPrs: any[], stateOf: (n: number) => string = () => "merged"): PrLookups {
  return {
    findPullRequestsForBranch: async () => branchPrs,
    getPullRequest: async (_c, n) => pr({ number: n, state: stateOf(n) }),
  };
}

test("sortPrs puts open PRs first, then highest number", () => {
  const ordered = sortPrs([pr({ number: 2, state: "merged" }), pr({ number: 5, state: "open" }), pr({ number: 9, state: "closed" }), pr({ number: 7, state: "open" })]);
  assert.deepEqual(ordered.map((p) => p.number), [7, 5, 2, 9], "open (num desc) then merged then closed");
});

test("reconcile merges branch + harvested + previously-known, deduped by URL", async () => {
  const gh = fakeLookups([pr({ number: 1, state: "open" })], (n) => (n === 1 ? "open" : "merged"));
  const prev = [pr({ number: 3, state: "open" })]; // was open, now re-fetched → merged
  const harvested = new Set([1, 2]); // 1 already known via branch, 2 is new
  const out = await reconcilePrsAgainstGitHub(gh, cfg, "branch", prev, harvested);
  assert.deepEqual(out.map((p) => p.number).sort((a, b) => a - b), [1, 2, 3], "all three sources present, deduped");
  assert.equal(out.find((p) => p.number === 3)!.state, "merged", "previously-known PR re-fetched to fresh state");
  assert.equal(out[0].state, "open", "sorted open-first");
});

test("reconcile keeps a stale entry when its re-fetch fails", async () => {
  const gh: PrLookups = { findPullRequestsForBranch: async () => [], getPullRequest: async () => undefined };
  const prev = [pr({ number: 8, state: "open" })];
  const out = await reconcilePrsAgainstGitHub(gh, cfg, "branch", prev, new Set());
  assert.deepEqual(out.map((p) => p.number), [8], "a token blip must not drop a PR the user already saw");
});

/** A deps bag with fake GitHub lookups; exercises the change-detection/persist
 *  wiring around the reconcile engine. */
function harness(branchPrs: any[], over: Partial<PrDetectionDeps> = {}) {
  const persisted: string[] = [];
  const broadcasts: any[] = [];
  const deps: PrDetectionDeps = {
    ...fakeLookups(branchPrs, (n) => (branchPrs.find((p) => p.number === n)?.state ?? "open")),
    broadcast: (p) => broadcasts.push(p),
    persistSessionMetadata: (r) => persisted.push(r.id),
    scheduleAdvertise: () => {},
    resolveTokenForRepo: async () => "tok",
    repoSessionParts: () => ({ wt: { branch: "b", repoRoot: "/repo" }, parsed: { owner: "o", repo: "r" } }),
    parseRepoSource: (s) => (s ? { owner: "o", repo: "r" } : undefined),
    nodeGithubMaxConcurrent: () => 4,
    listSessions: () => [],
    getLiveSession: () => undefined,
    upsertSession: () => {},
    ...over,
  };
  return { deps, persisted, broadcasts, detect: createPrDetection(deps) };
}

test("refreshPullRequests persists + broadcasts only on change", async () => {
  const { detect, persisted, broadcasts } = harness([pr({ number: 1, state: "open" })]);
  const record: PrSession = { id: "s1", session: { getMessages: () => [] } };

  const first = await detect.refreshPullRequests(record);
  assert.equal(first, true, "first reconcile is a change");
  assert.equal(record.prUrl, "https://github.com/o/r/pull/1");
  assert.deepEqual(persisted, ["s1"]);
  assert.equal(broadcasts.filter((b) => b.type === "session.pr_opened").length, 1);

  const second = await detect.refreshPullRequests(record);
  assert.equal(second, false, "unchanged reconcile does not persist/broadcast again");
  assert.deepEqual(persisted, ["s1"], "no second persist");
});

test("refreshPullRequests bails without a repo-backed worktree", async () => {
  const { detect, persisted } = harness([], { repoSessionParts: () => undefined });
  const changed = await detect.refreshPullRequests({ id: "s2", session: { getMessages: () => [] } });
  assert.equal(changed, false);
  assert.deepEqual(persisted, []);
});

test("maybeDetectPullRequest guards against re-entrancy via prDetecting", async () => {
  const { detect } = harness([]);
  const record: PrSession = { id: "s3", prDetecting: true, session: { getMessages: () => [] } };
  await detect.maybeDetectPullRequest(record);
  assert.equal(record.prDetecting, true, "an in-flight detection is left untouched (no double run)");
});
