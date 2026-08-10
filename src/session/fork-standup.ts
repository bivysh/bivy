// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Fork stand-up, extracted from server.ts. Stands a forked session up on THIS
// node from a ForkBundle: credential-move, (optional) prerequisite detection,
// repo/worktree reconstruction, transcript materialisation, and session creation.
// Shared by the cross-node `session.fork.import` and same-node `session.fork.local`
// paths.
//
// This is a consumer of createSession and a pile of git/clone/worktree/runtime
// machinery — all injected via ForkStandUpDeps so the ORCHESTRATION (especially
// the fresh-vs-adopt base-ref selection that keeps a cross-node fork's commits
// from being silently dropped) is unit-testable with fakes. The deterministic,
// side-effect-free prereq/parse helpers are imported directly and used real.
//
// Generic over the record type R (server passes SessionRecord) so the outcome it
// returns is the caller's own record type, not a narrowed copy.

import { randomBytes } from "node:crypto";
import { normalizeSandboxTier, type SandboxTier } from "../harness/sandbox.js";
import { parseRepo } from "../repo-workspace.js";
import { evaluateForkPrereqs, blockingForkPrereqs, missingForkPrereqs, type ForkPrereq, type ForkPrereqInput } from "../session/fork-prereqs.js";
import type { ForkBundle, ForkPlan, MaterializeForkOptions } from "../session/fork.js";
import type { Worktree } from "../worktree.js";
import type { AgentRuntime } from "../runtime/index.js";

type ModelRef = { provider: string; id: string };

/** Only the fields fork stand-up sets on the freshly-created session record. */
export interface ForkStandUpSession {
  id: string;
  sessionFile?: string;
  forkedFrom?: string;
  worktree?: Worktree;
  session: { getName(): string | undefined; setName(name: string): void };
}

export interface StandUpForkOptions {
  bundle: ForkBundle;
  /** Runtime to materialise into (may differ from the source for a cross-runtime fork). */
  targetRuntimeId: string;
  /** Explicit model to bind before the first turn; otherwise preserve it only for the same runtime. */
  model?: ModelRef;
  /** Full transcript URL, woven into a seeded (cross-runtime) continuation prompt. */
  transcriptUrl?: string;
  /**
   * Worktree strategy for a repo-backed source:
   *   - "adopt" — check out the source's branch (cross-node import; the source
   *     lives on a different node, so there's no local branch collision).
   *   - "fresh" — cut a NEW `<branch>-fork-<hex>` branch from the source branch
   *     (same-node fork; git forbids two worktrees on one branch and the source
   *     still holds it).
   */
  worktree: "adopt" | "fresh";
  /**
   * Run full prerequisite detection (a missing target agent is a hard blocker;
   * a missing model login / unreachable repo are surfaced as non-blocking
   * `missing[]`). Skipped for a same-node local fork.
   */
  detectPrereqs: boolean;
  /** cwd/workspace to use when the source is NOT repo-backed (no worktree). */
  fallback?: { workspace: string; cwd: string };
}

export type StandUpForkOutcome<R> =
  | { ok: false; error: string; missing: ForkPrereq[] }
  | { ok: true; record: R; plan: ForkPlan; missing: ForkPrereq[] };

/** Fork stand-up's entire coupling surface to the rest of the daemon. */
export interface ForkStandUpDeps<R extends ForkStandUpSession> {
  createSession(cwd: string, sessionFile: string | undefined, opts: { runtimeId: string; source?: string; sandbox?: SandboxTier; makeActive?: boolean }): Promise<R>;
  broadcast(payload: unknown): void;
  persistSessionMetadata(record: R): void;
  scheduleAdvertise(): void;
  bivySessionEnvelope(record: R): unknown;
  applyRequestedModel(record: R, model: ModelRef | undefined): Promise<void>;
  resolveTokenForRepo(owner: string, repo: string): Promise<string | undefined>;
  syncModelAuthFromControlPlane(): Promise<void>;
  /** Serialize clone-adjacent worktree ops per repo (shared mutex, stays server-side). */
  withRepoLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
  /** Whatever credential the store holds for `provider` (truthy = configured). */
  getProviderCredential(provider: string): Promise<unknown>;
  cloneOrUpdateRepo(args: { owner: string; repo: string; token?: string; root: string }): Promise<string>;
  createWorktree(args: { repoDir: string; id: string; branch?: string; base?: string }): Promise<Worktree>;
  resolveDefaultBaseRef(repoDir: string): Promise<string>;
  resolveAdoptBaseRef(repoDir: string, branch: string): Promise<string>;
  applyDirtyPatch(cwd: string, patch: ForkBundle["dirtyPatch"]): { warning?: string };
  gitRepoRoot(cwd: string): Promise<string | undefined>;
  materializeFork(args: MaterializeForkOptions): Promise<ForkPlan>;
  getRuntime(id: string, sandbox?: SandboxTier): AgentRuntime;
  listRuntimes(): Array<{ id: string; status?: string; displayName?: string }>;
  reposRoot: string;
  defaultWorkspace: string;
}

export interface ForkStandUp<R extends ForkStandUpSession> {
  standUpFork(opts: StandUpForkOptions): Promise<StandUpForkOutcome<R>>;
}

export function createForkStandUp<R extends ForkStandUpSession>(deps: ForkStandUpDeps<R>): ForkStandUp<R> {
  async function standUpFork(opts: StandUpForkOptions): Promise<StandUpForkOutcome<R>> {
    const { bundle, targetRuntimeId } = opts;
    const fallback = opts.fallback ?? { workspace: deps.defaultWorkspace, cwd: deps.defaultWorkspace };
    // Carry the source's sandbox tier so a sandboxed session forks into a
    // sandboxed one, rather than defaulting to this node's tier (fork.ts).
    const forkSandbox = normalizeSandboxTier(bundle.record.sandbox);

    // Credential-move: if the chosen model's provider isn't logged in on this node,
    // pull the account model-auth vault (a login done on another node carries over),
    // then re-check. Best-effort — a local-only node just skips it.
    const modelProvider = opts.model?.provider;
    const providerConfigured = async () =>
      modelProvider ? Boolean(await deps.getProviderCredential(modelProvider).catch(() => undefined)) : undefined;
    let modelConfigured = await providerConfigured();
    if (modelProvider && modelConfigured === false) {
      await deps.syncModelAuthFromControlPlane().catch(() => {});
      modelConfigured = await providerConfigured();
    }

    // Prerequisite detection. A missing AGENT is a hard blocker — stop before any
    // clone/worktree work. Skipped for a same-node local fork. Read the agent's
    // availability + display name from the runtime REGISTRY (which never throws)
    // rather than resolving the runtime up front: `getRuntime` throws for a
    // known-but-not-installed agent, which — called eagerly — surfaced a raw
    // "not available" string with an empty `missing[]` instead of this friendly
    // install checklist. An unknown id (no registry entry) is treated as
    // unavailable so it, too, degrades to the checklist rather than a getRuntime throw.
    const agentInfo = deps.listRuntimes().find((r) => r.id === targetRuntimeId);
    const agentAvailable = agentInfo ? agentInfo.status === "available" : false;
    const agentDisplayName = agentInfo?.displayName ?? targetRuntimeId;
    const prereqInput: ForkPrereqInput = {
      agent: { id: targetRuntimeId, displayName: agentDisplayName, available: agentAvailable },
      ...(modelProvider ? { model: { provider: modelProvider, configured: Boolean(modelConfigured) } } : {}),
    };
    if (opts.detectPrereqs) {
      const early = evaluateForkPrereqs(prereqInput);
      if (blockingForkPrereqs(early).length > 0) {
        return { ok: false, error: `${agentDisplayName} is not installed on the destination node.`, missing: missingForkPrereqs(early) };
      }
    }

    // Safe now: the agent is available (or this is a same-node local fork whose
    // agent is self-evidently present). The per-session sandbox tier bakes into
    // the runtime's launch flags.
    const targetRuntime = deps.getRuntime(targetRuntimeId, forkSandbox);

    // Reconstruct repo + worktree when the source was repo-backed.
    let workspace = fallback.workspace;
    let cwd = fallback.cwd;
    let repoReachable: boolean | undefined;
    let worktree: Worktree | undefined;
    let dirtyWarning: string | undefined;
    const parsed = bundle.record.repoSlug ? parseRepo(bundle.record.repoSlug) : undefined;
    if (parsed) {
      const token = await deps.resolveTokenForRepo(parsed.owner, parsed.repo);
      repoReachable = Boolean(token);
      const repoDir = await deps.cloneOrUpdateRepo({ owner: parsed.owner, repo: parsed.repo, token, root: deps.reposRoot });
      const srcBranch = bundle.record.branch;
      // Serialize clone-adjacent worktree ops on this repo so concurrent forks /
      // pickups don't race on `git worktree add` or clobber each other's trees.
      const wt = await deps.withRepoLock(repoDir, async () => {
        if (opts.worktree === "fresh") {
          // Same-node fork: cut a NEW branch from the source's LOCAL branch (which
          // holds its latest, possibly-unpushed commits) or the repo default.
          const forkBranch = `${srcBranch ?? "fork"}-fork-${randomBytes(4).toString("hex")}`;
          return deps.createWorktree({ repoDir, id: forkBranch, branch: forkBranch, base: srcBranch ?? await deps.resolveDefaultBaseRef(repoDir) });
        }
        // Cross-node adopt: the source branch has no LOCAL ref here. Base the
        // adopted branch on the pushed `origin/<branch>` so committed work travels
        // (was: undefined → the destination's DEFAULT branch, silently dropping
        // every commit). Give the worktree DIR a unique suffix so a same-branch
        // adopt never reuses — or, via createWorktree's stale-dir cleanup, deletes
        // — another live session's tree.
        const dirId = `${srcBranch ?? "fork"}-${randomBytes(4).toString("hex")}`;
        const base = srcBranch ? await deps.resolveAdoptBaseRef(repoDir, srcBranch) : await deps.resolveDefaultBaseRef(repoDir);
        return deps.createWorktree({ repoDir, id: dirId, branch: srcBranch, base });
      });
      const applied = deps.applyDirtyPatch(wt.path, bundle.dirtyPatch);
      if (applied.warning) dirtyWarning = applied.warning;
      workspace = repoDir;
      cwd = wt.path;
      worktree = wt;
    } else {
      // Non-repo-backed source. The fork would otherwise reuse the PARENT's cwd,
      // putting two sessions in one working tree — so when that cwd is itself a git
      // checkout (a local repo without a GitHub origin), cut the fork its own
      // worktree on a fresh branch. Best-effort: a non-git workspace has no tree to
      // isolate, so the fork keeps the fallback cwd (no git collisions possible).
      const forkRepoRoot = await deps.gitRepoRoot(cwd);
      if (forkRepoRoot) {
        const forkBranch = `bivy/fork-${randomBytes(6).toString("hex")}`;
        const wt = await deps.withRepoLock(forkRepoRoot, () => deps.createWorktree({ repoDir: forkRepoRoot, id: forkBranch, branch: forkBranch }));
        const applied = deps.applyDirtyPatch(wt.path, bundle.dirtyPatch);
        if (applied.warning) dirtyWarning = applied.warning;
        workspace = forkRepoRoot;
        cwd = wt.path;
        worktree = wt;
      }
    }

    // Materialise the transcript, then stand the session up — resume the imported
    // transcript (full) or a fresh session the caller seeds with plan.seedPrompt.
    // Preserve the source model only when the runtime itself is unchanged. A
    // cross-agent fork must let the destination choose its own default unless the
    // caller explicitly supplied a model valid for that target.
    const targetModel = opts.model ?? (targetRuntimeId === bundle.record.runtimeId ? bundle.record.modelRef : undefined);
    const plan = await deps.materializeFork({ bundle, targetRuntime, ctx: { workspace, cwd, model: targetModel }, seed: { transcriptUrl: opts.transcriptUrl } });
    const record = plan.kind === "resume"
      ? await deps.createSession(cwd, plan.sessionFile, { runtimeId: targetRuntimeId, source: bundle.record.source, sandbox: forkSandbox, makeActive: false })
      : await deps.createSession(cwd, undefined, { runtimeId: targetRuntimeId, source: bundle.record.source, sandbox: forkSandbox, makeActive: false });
    // Mark the new session as a fork of its source, so the run card can show
    // "Forked from …" and the lineage survives a reload (persisted below).
    record.forkedFrom = bundle.record.sourceSessionId;
    // Attach the reconstructed worktree to the record. createSession only
    // populates record.worktree when it provisions one itself or restores it from
    // stored metadata — neither happens for a fork, whose worktree we cut above.
    // Without this, repoSessionParts() can't see the fork as repo-backed, so
    // branch-push, PR detection and /pr all silently bail.
    if (worktree && !record.worktree) {
      record.worktree = worktree;
      deps.broadcast({ type: "session.updated", sessionId: record.id, sessionFile: record.sessionFile, bivySession: deps.bivySessionEnvelope(record) });
    }
    if (bundle.record.title && !record.session.getName()) record.session.setName(bundle.record.title);
    // Surface a non-fatal note when the source's uncommitted changes didn't apply
    // cleanly, so the fork isn't silently missing work-in-progress.
    if (dirtyWarning) deps.broadcast({ type: "session.notice", sessionId: record.id, message: dirtyWarning });
    await deps.applyRequestedModel(record, targetModel);
    deps.persistSessionMetadata(record);
    deps.scheduleAdvertise();

    const missing = opts.detectPrereqs
      ? missingForkPrereqs(evaluateForkPrereqs({
          ...prereqInput,
          ...(parsed ? { repo: { slug: parsed.slug, reachable: Boolean(repoReachable) } } : {}),
        }))
      : [];
    return { ok: true, record, plan, missing };
  }

  return { standUpFork };
}
