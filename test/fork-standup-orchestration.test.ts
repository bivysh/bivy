// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Characterization tests for the fork stand-up ORCHESTRATION extracted from
// server.ts. This is the safety net the extraction lacked: it pins the subtle
// decisions the inline function's comments warn about — above all the fresh-vs-
// adopt base-ref selection that keeps a cross-node fork's commits from being
// silently dropped. (test/fork-standup.test.ts separately covers the real git
// primitives; this drives the decision logic with fakes.)
import { strict as assert } from "node:assert";
import test from "node:test";

import { createForkStandUp, type ForkStandUpDeps, type StandUpForkOptions } from "../src/session/fork-standup.js";

type FakeRecord = {
  id: string;
  sessionFile?: string;
  forkedFrom?: string;
  worktree?: any;
  session: { name?: string; getName(): string | undefined; setName(n: string): void };
};

function fakeRecord(over: Partial<FakeRecord> = {}): FakeRecord {
  const rec: FakeRecord = {
    id: over.id ?? "new-session",
    sessionFile: over.sessionFile,
    worktree: over.worktree,
    session: { name: (over as any).name, getName() { return this.name; }, setName(n: string) { this.name = n; } },
  };
  return rec;
}

function bundle(over: any = {}) {
  // Note: use `in` checks, not `?? default`, so an EXPLICIT `undefined` (e.g. the
  // "no source branch" / "non-repo" cases) actually overrides the default.
  const record: any = {
    sandbox: undefined,
    source: "repo:octo/repo",
    runtimeId: "claude-code-sdk",
    modelRef: { provider: "anthropic", id: "claude" },
    repoSlug: "octo/repo",
    branch: "feature-x",
    sourceSessionId: "src-1",
    title: undefined,
  };
  for (const k of ["repoSlug", "branch", "sourceSessionId", "title", "sandbox", "runtimeId", "modelRef", "source"]) {
    if (k in over) record[k] = over[k];
  }
  return { record, dirtyPatch: over.dirtyPatch } as any;
}

function harness(over: Partial<ForkStandUpDeps<FakeRecord>> = {}) {
  const calls: any = { createWorktree: [], createSession: [], broadcast: [], synced: 0, appliedModel: [] };
  const created = over.createSession ? undefined : fakeRecord();
  const deps: ForkStandUpDeps<FakeRecord> = {
    createSession: async (cwd, sessionFile, opts) => { calls.createSession.push({ cwd, sessionFile, opts }); return created!; },
    broadcast: (p) => calls.broadcast.push(p),
    persistSessionMetadata: () => {},
    scheduleAdvertise: () => {},
    bivySessionEnvelope: () => ({}),
    applyRequestedModel: async (_r, m) => { calls.appliedModel.push(m); },
    resolveTokenForRepo: async () => "tok",
    syncModelAuthFromControlPlane: async () => { calls.synced++; },
    withRepoLock: async (_k, fn) => fn(),
    getProviderCredential: async () => "cred",
    cloneOrUpdateRepo: async () => "/repo",
    createWorktree: async (args) => { calls.createWorktree.push(args); return { path: "/repo/wt", branch: args.branch ?? "b", repoRoot: "/repo" } as any; },
    resolveDefaultBaseRef: async () => "origin/main",
    resolveAdoptBaseRef: async (_d, branch) => `origin/${branch}`,
    resolveForkBaseRef: async (_d, branch) => branch ?? "origin/main",
    originBranchPresent: async () => true,
    applyDirtyPatch: () => ({}),
    gitRepoRoot: async () => undefined,
    materializeFork: async () => ({ kind: "resume", sessionFile: "/s.json" } as any),
    getRuntime: () => ({} as any),
    listRuntimes: () => [{ id: "claude-code-sdk", status: "available", displayName: "Claude Code" }],
    reposRoot: "/repos",
    defaultWorkspace: "/ws",
    ...over,
  };
  return { deps, calls, created, standUp: createForkStandUp<FakeRecord>(deps) };
}

const opts = (over: Partial<StandUpForkOptions> = {}): StandUpForkOptions => ({
  bundle: bundle(),
  targetRuntimeId: "claude-code-sdk",
  worktree: "adopt",
  detectPrereqs: false,
  ...over,
});

test("oversized dirty state blocks before any clone/session work", async () => {
  const { calls, standUp } = harness();
  const outcome = await standUp.standUpFork(opts({
    bundle: { ...bundle(), dirtyPatch: { patch: "", untracked: ["large.bin"], pushedInstead: true, byteLength: 8192, maxBytes: 1024 } },
  }));
  assert.equal(outcome.ok, false);
  assert.match(outcome.ok ? "" : outcome.error, /uncommitted changes/i);
  assert.equal(calls.createWorktree.length, 0);
  assert.equal(calls.createSession.length, 0);
});

test("an uncommitted patch that cannot apply never creates a lossy destination", async () => {
  const { calls, standUp } = harness({
    applyDirtyPatch: () => ({ applied: false, warning: "patch base is unavailable" }),
  });
  const outcome = await standUp.standUpFork(opts({
    bundle: { ...bundle(), dirtyPatch: { patch: "diff --git a/file b/file", untracked: [] } },
  }));
  assert.equal(outcome.ok, false);
  assert.match(outcome.ok ? "" : outcome.error, /patch base is unavailable/);
  assert.equal(calls.createSession.length, 0);
});

test("a blocking prereq (agent unavailable) stops before any clone/session work", async () => {
  const { standUp, calls } = harness({ listRuntimes: () => [{ id: "claude-code-sdk", status: "not_installed", displayName: "Claude Code" }] });
  const outcome = await standUp.standUpFork(opts({ detectPrereqs: true }));
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.ok(outcome.missing.length > 0, "surfaces an install checklist");
  assert.deepEqual(calls.createSession, [], "no session created when blocked");
  assert.deepEqual(calls.createWorktree, [], "no worktree cut when blocked");
});

test("ADOPT bases the worktree on origin/<branch> so cross-node commits travel", async () => {
  const { standUp, calls } = harness();
  await standUp.standUpFork(opts({ worktree: "adopt" }));
  assert.equal(calls.createWorktree.length, 1);
  const wt = calls.createWorktree[0];
  assert.equal(wt.branch, "feature-x", "adopts the source branch");
  assert.equal(wt.base, "origin/feature-x", "base is the pushed origin ref, NOT the repo default — the commit-drop guard");
});

test("FRESH cuts a new branch based on the resilient fork-base resolver", async () => {
  const resolved: Array<{ repoDir: string; branch: string | undefined; worktree: string | undefined }> = [];
  const { standUp, calls } = harness({
    resolveForkBaseRef: async (repoDir, branch, worktree) => {
      resolved.push({ repoDir, branch, worktree });
      return "resolved-source-tip";
    },
  });
  await standUp.standUpFork(opts({ worktree: "fresh" }));
  const wt = calls.createWorktree[0];
  assert.match(wt.branch, /^feature-x-fork-[0-9a-f]{8}$/, "new <branch>-fork-<hex> branch");
  assert.equal(wt.base, "resolved-source-tip");
  assert.deepEqual(resolved, [{ repoDir: "/repo", branch: "feature-x", worktree: undefined }]);
});

test("ADOPT blocks (no silent commit loss) when the source branch isn't on the remote", async () => {
  // The source branch never reached origin; adopting would base off the default
  // and drop its commits. The 1A gate must refuse and surface it, not proceed.
  const { standUp, calls } = harness({ originBranchPresent: async () => false });
  const outcome = await standUp.standUpFork(opts({ worktree: "adopt", detectPrereqs: true }));
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.ok(outcome.missing.some((m) => m.kind === "commits" && m.fix === "source.push"), "surfaces a push-the-branch checklist item");
  }
  assert.deepEqual(calls.createWorktree, [], "no worktree cut — refuses rather than dropping commits");
  assert.deepEqual(calls.createSession, [], "no session stood up on the wrong base");
});

test("ADOPT proceeds normally when the branch IS on the remote (no false positive)", async () => {
  const { standUp, calls } = harness({ originBranchPresent: async () => true });
  const outcome = await standUp.standUpFork(opts({ worktree: "adopt", detectPrereqs: true }));
  assert.ok(outcome.ok);
  assert.equal(calls.createWorktree[0].base, "origin/feature-x", "adopts the pushed branch");
});

test("same-node FRESH fork is exempt from the remote-branch gate (can't lose commits)", async () => {
  // A never-pushed branch on a same-node fork bases off the live source tip, so
  // the gate (adopt-only) must not fire even with the branch absent from origin.
  const { standUp, calls } = harness({ originBranchPresent: async () => false });
  const outcome = await standUp.standUpFork(opts({ worktree: "fresh", detectPrereqs: true }));
  assert.ok(outcome.ok);
  assert.equal(calls.createWorktree.length, 1);
});

test("ADOPT with no source branch falls back to the repo default base", async () => {
  const { standUp, calls } = harness();
  await standUp.standUpFork(opts({ worktree: "adopt", bundle: bundle({ branch: undefined }) }));
  assert.equal(calls.createWorktree[0].base, "origin/main");
});

test("marks forkedFrom, attaches the worktree, and broadcasts session.updated", async () => {
  const { standUp, calls, created } = harness();
  const outcome = await standUp.standUpFork(opts());
  assert.ok(outcome.ok);
  assert.equal(created!.forkedFrom, "src-1", "lineage recorded");
  assert.equal(created!.worktree?.path, "/repo/wt", "reconstructed worktree attached");
  assert.ok(calls.broadcast.some((b: any) => b.type === "session.updated"));
});

test("in-flight source state is disclosed on the destination (no silent loss)", async () => {
  const { standUp, calls } = harness();
  const b = bundle();
  (b as any).state = { working: true, pendingApprovals: [{ toolName: "bash", requestId: "r1" }] };
  const outcome = await standUp.standUpFork(opts({ bundle: b }));
  assert.ok(outcome.ok);
  const notice = calls.broadcast.find((p: any) => p.type === "session.notice" && /pending tool approval/.test(p.message));
  assert.ok(notice, "the destination broadcasts a notice disclosing the source's pending approval / unfinished turn");
});

test("no in-flight notice when the source had nothing pending", async () => {
  const { standUp, calls } = harness();
  await standUp.standUpFork(opts());
  const notice = calls.broadcast.find((p: any) => p.type === "session.notice" && /pending tool approval|unfinished turn/.test(p.message ?? ""));
  assert.equal(notice, undefined, "no spurious in-flight notice for a clean fork");
});

test("resume plan creates from the transcript file; fresh plan creates blank", async () => {
  const resume = harness();
  await resume.standUp.standUpFork(opts());
  assert.equal(resume.calls.createSession[0].sessionFile, "/s.json", "resume threads the materialised transcript");

  const fresh = harness({ materializeFork: async () => ({ kind: "fresh" } as any) });
  await fresh.standUp.standUpFork(opts());
  assert.equal(fresh.calls.createSession[0].sessionFile, undefined, "fresh plan seeds a blank session");
});

test("non-repo source with a git checkout cuts an isolated fork worktree", async () => {
  const { standUp, calls } = harness({ gitRepoRoot: async () => "/local/repo" });
  await standUp.standUpFork(opts({ bundle: bundle({ repoSlug: undefined }) }));
  assert.equal(calls.createWorktree.length, 1, "isolates the fork so two sessions don't share one tree");
  assert.match(calls.createWorktree[0].branch, /^bivy\/fork-[0-9a-f]{12}$/);
});

test("non-repo, non-git source keeps the fallback cwd with no worktree", async () => {
  const { standUp, calls } = harness({ gitRepoRoot: async () => undefined });
  await standUp.standUpFork(opts({ bundle: bundle({ repoSlug: undefined }), fallback: { workspace: "/fallback", cwd: "/fallback" } }));
  assert.deepEqual(calls.createWorktree, [], "no tree to isolate");
  assert.equal(calls.createSession[0].cwd, "/fallback");
});

test("credential-move: an unconfigured provider triggers a vault sync then re-check", async () => {
  let configured = false;
  const { standUp, calls } = harness({ getProviderCredential: async () => (configured ? "cred" : (configured = true, undefined)) });
  await standUp.standUpFork(opts({ model: { provider: "openai", id: "gpt" } }));
  assert.equal(calls.synced, 1, "pulled the account model-auth vault when the provider looked unconfigured");
});

test("applies the requested model and preserves title only when the record is unnamed", async () => {
  const { standUp, calls, created } = harness();
  await standUp.standUpFork(opts({ bundle: bundle({ title: "Source Title" }), model: { provider: "anthropic", id: "opus" } }));
  assert.equal(created!.session.getName(), "Source Title", "unnamed fork inherits the source title");
  assert.deepEqual(calls.appliedModel[0], { provider: "anthropic", id: "opus" });
});
