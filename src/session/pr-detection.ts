// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Pull-request detection/refresh, extracted from server.ts. Reconciles a
// session's PR list against GitHub (branch PRs + transcript-harvested numbers +
// previously-known PRs) and keeps `prs`/`prUrl` in sync after each turn, on
// demand, and via a global scan.
//
// Like the turn watchdog, it operates on a NARROW session shape (PrSession, not
// the ~50-field SessionRecord) and reaches the daemon only through the injected
// PrDetectionDeps — so its whole coupling surface is one readable interface and
// the reconcile engine unit-tests without a live server. Even the two GitHub
// read primitives are injected (PrLookups), so reconcile is a pure function of
// its inputs; server.ts passes the real ./github-tasks implementations.

import type { PrRef, MetadataSession } from "../metadata.js";
import type { GitHubTaskConfig } from "../github-tasks.js";

type PrState = PrRef["state"];

/** The two GitHub read primitives the reconcile engine needs — injected rather
 *  than imported so the engine is a pure function of its inputs and unit-tests
 *  with fakes. server.ts passes the real ./github-tasks implementations. */
export interface PrLookups {
  findPullRequestsForBranch(cfg: GitHubTaskConfig, branch: string): Promise<PrRef[]>;
  getPullRequest(cfg: GitHubTaskConfig, n: number): Promise<PrRef | undefined>;
}

/** Only the session fields PR detection reads or writes. */
export interface PrSession {
  id: string;
  prs?: PrRef[];
  prUrl?: string;
  prDetecting?: boolean;
  session: { getMessages(): unknown };
}

/** The repo-backed slice repoSessionParts returns — structural so this module
 *  needn't import the server's Worktree/ParsedRepo types. */
interface RepoParts {
  wt: { branch: string; repoRoot: string };
  parsed: { owner: string; repo: string };
}

/** PR detection's entire coupling surface to the rest of the daemon. */
export interface PrDetectionDeps extends PrLookups {
  broadcast(payload: unknown): void;
  persistSessionMetadata(record: PrSession): void;
  scheduleAdvertise(): void;
  resolveTokenForRepo(owner: string, repo: string): Promise<string | undefined>;
  repoSessionParts(record: PrSession): RepoParts | undefined;
  parseRepoSource(source: string | undefined): { owner: string; repo: string } | undefined;
  nodeGithubMaxConcurrent(): number;
  listSessions(): MetadataSession[];
  getLiveSession(id: string): PrSession | undefined;
  upsertSession(patch: { id: string; prs?: PrRef[]; prUrl?: string }): void;
}

export interface PrDetection {
  refreshPullRequests(record: PrSession): Promise<boolean>;
  refreshAllPullRequestStatuses(): Promise<{ scanned: number; changed: number }>;
  maybeDetectPullRequest(record: PrSession): Promise<void>;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Order a merged PR set for a one-badge row: open first (the actionable one),
 *  then by PR number descending (newest first) within each state group. */
export function sortPrs(prs: PrRef[]): PrRef[] {
  const rank = (s: PrState) => (s === "open" ? 0 : s === "merged" ? 1 : 2);
  return [...prs].sort((a, b) => rank(a.state) - rank(b.state) || (b.number ?? 0) - (a.number ?? 0));
}

/** The canonical GitHub task config for Bivy-managed repos. Centralizes the
 *  label/poll literals that were duplicated at every reconcile call site. */
function bivyGitHubConfig(token: string, owner: string, repo: string, repoDir: string): GitHubTaskConfig {
  return { token, owner, repo, repoDir, label: "bivy", claimLabel: "bivy:in-progress", pollMs: 60_000 };
}

/**
 * Harvest PR numbers this session references in its own transcript — the URL a
 * `gh pr create` / GitHub-MCP call returns, or that the agent restates in its
 * reply. Branch-scoped lookups only see the session's *own* worktree branch, so
 * this is what surfaces PRs a session opens on other branches (the multi-PR
 * case). Same-repo only, capped, best-effort.
 */
function harvestPrNumbers(record: PrSession, owner: string, repo: string): Set<number> {
  const nums = new Set<number>();
  try {
    const json = JSON.stringify(record.session.getMessages());
    const re = new RegExp(`github\\.com/${escapeRegExp(owner)}/${escapeRegExp(repo)}/pull/(\\d+)`, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(json)) && nums.size < 30) {
      const n = Number(m[1]);
      if (n) nums.add(n);
    }
  } catch {
    // getMessages/stringify can throw on an odd runtime state — harvesting is a
    // best-effort augmentation, never let it break the after-turn hook.
  }
  return nums;
}

/**
 * Combine three PR signals into one fresh list, deduped by URL: (1) every PR
 * whose head is `branch`, (2) every PR referenced by number in `harvestNumbers`
 * (fetched individually for fresh state), and (3) every previously-known PR not
 * already re-surfaced by (1) or (2), re-fetched by number so a merge/close is
 * reflected even once its branch stops matching. Pure but for the two injected-
 * free GitHub lookups, so it unit-tests with fakes.
 */
export async function reconcilePrsAgainstGitHub(gh: PrLookups, cfg: GitHubTaskConfig, branch: string, prevPrs: PrRef[] | undefined, harvestNumbers: Set<number>): Promise<PrRef[]> {
  const byUrl = new Map<string, PrRef>();
  for (const pr of await gh.findPullRequestsForBranch(cfg, branch)) byUrl.set(pr.url, pr);

  const knownByNumber = new Set<number>();
  for (const pr of byUrl.values()) if (pr.number != null) knownByNumber.add(pr.number);

  for (const n of harvestNumbers) {
    if (knownByNumber.has(n)) continue;
    const pr = await gh.getPullRequest(cfg, n);
    if (pr) { byUrl.set(pr.url, pr); if (pr.number != null) knownByNumber.add(pr.number); }
  }

  // Keep the stale entry if the fetch fails (a token blip shouldn't drop a PR
  // the user already saw).
  for (const prev of prevPrs ?? []) {
    if (byUrl.has(prev.url)) continue;
    const pr = prev.number != null ? await gh.getPullRequest(cfg, prev.number) : undefined;
    byUrl.set(prev.url, pr ?? prev);
  }

  return sortPrs([...byUrl.values()]);
}

export function createPrDetection(deps: PrDetectionDeps): PrDetection {
  /**
   * Reconcile this session's PR list against GitHub. Updates `record.prs` and
   * keeps `record.prUrl` on the live *open* PR (undefined once all are
   * merged/closed, so the "already has a PR" guards allow a fresh one). Persists
   * + broadcasts only on change, so it's cheap after each turn.
   */
  async function refreshPullRequests(record: PrSession): Promise<boolean> {
    const parts = deps.repoSessionParts(record);
    if (!parts) return false;
    const { wt, parsed } = parts;
    const token = await deps.resolveTokenForRepo(parsed.owner, parsed.repo);
    if (!token) return false; // can't query without a token
    const cfg = bivyGitHubConfig(token, parsed.owner, parsed.repo, wt.repoRoot);
    const prs = await reconcilePrsAgainstGitHub(deps, cfg, wt.branch, record.prs, harvestPrNumbers(record, parsed.owner, parsed.repo));
    const openUrl = prs.find((p) => p.state === "open")?.url;
    const changed = JSON.stringify(prs) !== JSON.stringify(record.prs ?? []) || openUrl !== record.prUrl;
    if (!changed) return false;
    record.prs = prs;
    record.prUrl = openUrl;
    deps.persistSessionMetadata(record);
    deps.broadcast({ type: "session.pr_opened", sessionId: record.id, prUrl: openUrl, prs });
    deps.scheduleAdvertise();
    return true;
  }

  /**
   * Same reconciliation as `refreshPullRequests`, but for a session that's only a
   * persisted MetadataSession row — not live in openSessions. Used by the global
   * scan so reconciling hundreds of finished sessions doesn't spin up hundreds of
   * runtimes. No transcript to harvest, so only previously-known PRs and the
   * session's own branch are reconciled — enough to flip a stale badge.
   */
  async function refreshPullRequestsForMeta(meta: MetadataSession): Promise<boolean> {
    if (!meta.branch) return false;
    const parsed = deps.parseRepoSource(meta.source);
    if (!parsed) return false;
    const token = await deps.resolveTokenForRepo(parsed.owner, parsed.repo);
    if (!token) return false;
    const cfg = bivyGitHubConfig(token, parsed.owner, parsed.repo, meta.worktree ?? "");
    const prs = await reconcilePrsAgainstGitHub(deps, cfg, meta.branch, meta.prs, new Set());
    const openUrl = prs.find((p) => p.state === "open")?.url;
    const changed = JSON.stringify(prs) !== JSON.stringify(meta.prs ?? []) || openUrl !== meta.prUrl;
    if (!changed) return false;
    deps.upsertSession({ id: meta.id, prs, prUrl: openUrl });
    deps.broadcast({ type: "session.pr_opened", sessionId: meta.id, prUrl: openUrl, prs });
    deps.scheduleAdvertise();
    return true;
  }

  /**
   * Global "refresh GitHub status" scan: reconcile every session this node has
   * ever tracked that carries PR state, so stale `open` badges left by finished
   * sessions flip to merged/closed. Live sessions take the full path (transcript
   * harvest); everything else the cheaper metadata path. Bounded concurrency
   * keeps the GitHub call count sane.
   */
  async function refreshAllPullRequestStatuses(): Promise<{ scanned: number; changed: number }> {
    const candidates = deps.listSessions().filter((meta) => {
      if (!meta.branch || !deps.parseRepoSource(meta.source)) return false;
      return Boolean(meta.prUrl) || Boolean(meta.prs && meta.prs.length > 0);
    });
    let scanned = 0;
    let changed = 0;
    let next = 0;
    const concurrency = Math.max(1, Math.min(deps.nodeGithubMaxConcurrent() || 4, candidates.length || 1));
    async function worker() {
      for (;;) {
        const i = next++;
        if (i >= candidates.length) return;
        const meta = candidates[i];
        scanned++;
        try {
          const live = deps.getLiveSession(meta.id);
          const didChange = live ? await refreshPullRequests(live) : await refreshPullRequestsForMeta(meta);
          if (didChange) changed++;
        } catch (error) {
          console.warn(`[github] could not refresh PR status for session ${meta.id}`, error);
        }
      }
    }
    await Promise.all(Array.from({ length: concurrency }, worker));
    return { scanned, changed };
  }

  /**
   * Detect (and keep in sync) the pull requests for this session's branch — PRs
   * opened out-of-band by the agent's `gh pr create`, the GitHub API, or the web
   * UI, plus state changes on ones already known. Runs after each turn; a single
   * cheap GitHub lookup. Keeps refreshing so the badge tracks the PR through merge.
   */
  async function maybeDetectPullRequest(record: PrSession): Promise<void> {
    if (!deps.repoSessionParts(record) || record.prDetecting) return;
    record.prDetecting = true;
    try {
      await refreshPullRequests(record);
    } finally {
      record.prDetecting = false;
    }
  }

  return { refreshPullRequests, refreshAllPullRequestStatuses, maybeDetectPullRequest };
}
