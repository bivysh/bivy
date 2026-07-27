// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
// Normalization + GitHub-source helpers for the session store. Split out of
// store.ts so the reducer keeps only state-folding logic. These coerce untrusted
// wire payloads into the clean shapes the reducer stores; they hold no state.

import { isValidAgentCommand, type SlashCommand } from "./slash.js";
import type {
  ApprovalRequest,
  GithubContext,
  ModelInfo,
  NodeStats,
  PrRef,
  PrState,
  RuntimeInfo,
  SandboxTier,
  SessionStatus,
  SessionSummary,
  ThinkingState,
  Usage,
  UserQuestionItem,
} from "./store.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Validate + de-dupe an advertised `commands` array off the wire into clean
 * SlashCommand entries the composer can trust. Malformed entries (missing/short
 * name, non-slash) are dropped; only the two known invocation modes survive.
 * Hardens the store against a shim advertising junk in its handshake.
 */
export function normalizeAgentCommands(raw: unknown): SlashCommand[] {
  if (!Array.isArray(raw)) return [];
  const out: SlashCommand[] = [];
  const seen = new Set<string>();
  for (const c of raw) {
    if (!isValidAgentCommand(c) || seen.has(c.name)) continue;
    seen.add(c.name);
    const cmd: SlashCommand = { name: c.name };
    if (typeof c.description === "string" && c.description) cmd.description = c.description;
    if (c.mode === "protocol" || c.mode === "prompt") cmd.mode = c.mode;
    out.push(cmd);
  }
  return out;
}

/** Order-sensitive equality on two command lists — so an idempotent re-advertise
 *  keeps the same map identity (no needless composer re-render). */
export function sameCommandList(a: SlashCommand[], b: SlashCommand[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.name !== b[i]!.name || a[i]!.description !== b[i]!.description || a[i]!.mode !== b[i]!.mode) return false;
  }
  return true;
}

/** Normalize an unknown `prs` payload into a clean PrRef[]. Tolerates a bare
 *  `prUrl` from an older node by synthesizing a single open PR, so both the
 *  sidebar badge and header pill still light up against pre-`prs` nodes. */
export function normalizePrs(value: unknown, fallbackPrUrl?: unknown): PrRef[] {
  const out: PrRef[] = [];
  if (Array.isArray(value)) {
    for (const p of value) {
      const url = typeof p?.url === "string" ? p.url : "";
      if (!url) continue;
      const state: PrState = p?.state === "merged" || p?.state === "closed" ? p.state : "open";
      out.push({ url, state, number: typeof p?.number === "number" ? p.number : undefined, title: typeof p?.title === "string" ? p.title : undefined });
    }
  }
  if (out.length === 0 && typeof fallbackPrUrl === "string" && fallbackPrUrl) {
    out.push({ url: fallbackPrUrl, state: "open" });
  }
  return out;
}

/** The single PR to represent a session on a one-badge row: the open one if any,
 *  else the first (the node orders the list open-first, then by recency). */
export function primaryPr(prs: PrRef[] | undefined): PrRef | undefined {
  if (!prs || prs.length === 0) return undefined;
  return prs.find((p) => p.state === "open") ?? prs[0];
}

const SANDBOX_TIER_VALUES: SandboxTier[] = ["read-only", "workspace-write", "danger-full-access"];

/** Coerce a wire value to a SandboxTier, or undefined if it isn't a known tier. */
export function normalizeSandboxTier(value: unknown): SandboxTier | undefined {
  const raw = String(value ?? "").trim().toLowerCase().replace(/_/g, "-");
  return (SANDBOX_TIER_VALUES as string[]).includes(raw) ? (raw as SandboxTier) : undefined;
}

/** `owner/name` for a repo-backed session's `source` (e.g. "repo:owner/name"),
 *  or null otherwise. Exported so view-layer code (session list rows, repo
 *  menu items) shares this one parse instead of re-deriving it per call site. */
export function repoFromSource(source: unknown): string | null {
  return typeof source === "string" && source.startsWith("repo:") ? source.slice(5) : null;
}

/** True when a session was spawned by the GitHub-app work queue (a labelled
 *  issue picked up by the hosted queue or the local poller — see
 *  `runIssueTask`/`runWorkItem` in src/server.ts) rather than opened by hand.
 *  `issue:owner/repo#123` covers issue-backed runs; `queue:<source>` covers
 *  the generic no-repo case (e.g. a Slack-triggered prompt). These sessions
 *  get their own "GitHub Queue" screen instead of the regular session list —
 *  exported so both list views agree on the one split. */
export function isGithubQueueSource(source: unknown): boolean {
  return typeof source === "string" && (source.startsWith("issue:") || source.startsWith("queue:"));
}

/** Parse `issue:owner/repo#123` into its repo slug + issue number, or null for
 *  anything else (including the repo-less `queue:` sessions, which have no
 *  single issue to link to). Used by the GitHub Queue screen to link each row
 *  back to the originating issue. */
export function githubIssueRefFromSource(source: unknown): { repo: string; issueNumber: number } | null {
  if (typeof source !== "string" || !source.startsWith("issue:")) return null;
  const rest = source.slice("issue:".length);
  const hashIdx = rest.lastIndexOf("#");
  if (hashIdx === -1) return null;
  const repo = rest.slice(0, hashIdx);
  const issueNumber = Number(rest.slice(hashIdx + 1));
  if (!repo || !Number.isFinite(issueNumber)) return null;
  return { repo, issueNumber };
}

/** Derive the active session's GitHub context from a session.history event. */
export function githubContext(event: any): GithubContext {
  const source = event?.source;
  const repo = repoFromSource(source);
  let issueUrl: string | null = event?.githubIssueUrl || null;
  if (!issueUrl && typeof source === "string" && source.startsWith("github:issue")) {
    issueUrl = source.split(":").slice(1).join(":") || null;
  }
  const prs = normalizePrs(event?.prs, event?.prUrl);
  return {
    issueUrl,
    prUrl: (primaryPr(prs)?.state === "open" ? primaryPr(prs)?.url : null) ?? event?.prUrl ?? null,
    branch: event?.branch || null,
    repo,
    prs,
  };
}

/** Build a GithubContext from a sidebar row we already have, so the header pill
 *  paints instantly on open instead of waiting on the session.history round-trip
 *  (the row already carries branch/prUrl/prs from sessions.list). applyHistory
 *  reconciles to the canonical context when it lands. */
export function githubFromSummary(s: SessionSummary): GithubContext {
  return githubContext({ source: s.source, branch: s.branch, prUrl: s.prUrl, prs: s.prs });
}

export function normalizeUsage(usage: any): Usage | null {
  if (!usage || typeof usage !== "object") return null;
  const hasCost = typeof usage.costUsd === "number";
  const hasTokens = usage.tokens && typeof usage.tokens.total === "number";
  const hasPlan = usage.plan && Array.isArray(usage.plan.windows) && usage.plan.windows.length;
  if (!hasCost && !hasTokens && !hasPlan) return null;
  return usage as Usage;
}

/** Accept a node-stats snapshot only if at least one resource section is
 *  present and numeric, so a garbled/empty frame doesn't blank a good panel. */
export function normalizeNodeStats(stats: any): NodeStats | null {
  if (!stats || typeof stats !== "object") return null;
  const hasMem = stats.memory?.node && typeof stats.memory.node.total === "number";
  const hasCpu = stats.cpu?.node && typeof stats.cpu.node.usedPct === "number";
  const hasStorage = stats.storage?.node && typeof stats.storage.node.total === "number";
  if (!hasMem && !hasCpu && !hasStorage) return null;
  return stats as NodeStats;
}

/** Defensive shape-check mirroring src/runtime/claude-code.ts's own
 *  `validQuestions`: QuestionCard has no ErrorBoundary above it, so a malformed
 *  item must be dropped here rather than reach render. */
export function validUserQuestions(value: unknown): UserQuestionItem[] | null {
  if (!Array.isArray(value) || !value.length) return null;
  for (const q of value) {
    if (typeof q?.question !== "string" || typeof q?.header !== "string") return null;
    if (!Array.isArray(q.options) || q.options.length < 2) return null;
    for (const opt of q.options) {
      if (typeof opt?.label !== "string") return null;
    }
  }
  return value as UserQuestionItem[];
}

export function normalizeSessions(list: any, prev: SessionSummary[] = []): SessionSummary[] {
  if (!Array.isArray(list)) return [];
  // Dedupe by sessionId as we go: the sidebar keys each row on it, so a list
  // that ever carried the same id twice (e.g. a node merging sessions from more
  // than one runtime) would render duplicate rows and trip React's duplicate-key
  // warning. Keep the first occurrence — the node already sorts newest-first.
  const prevById = new Map(prev.map((s) => [s.sessionId, s]));
  const byId = new Map<string, SessionSummary>();
  for (const s of list) {
    const sessionId = String(s?.sessionId || s?.id || "");
    if (!sessionId || byId.has(sessionId)) continue;
    byId.set(sessionId, {
      sessionId,
      path: s?.path || s?.sessionFile || undefined,
      workspace: s?.workspace || s?.bivySession?.workspace || undefined,
      worktree: s?.worktree || s?.bivySession?.worktree || s?.bivySession?.workspaceContext?.worktree || undefined,
      name: String(s?.name || "Untitled session"),
      source: s?.source,
      nodeId: s?.nodeId || undefined,
      runtimeId: s?.runtimeId,
      agentName: s?.agentName,
      updatedAt: s?.updatedAt || s?.modified,
      needsAction: Boolean(s?.needsAction),
      status: normalizeSessionStatus(s?.status, Boolean(s?.needsAction), Boolean(s?.isStreaming)),
      branch: s?.branch || undefined,
      sandbox: normalizeSandboxTier(s?.sandbox ?? s?.bivySession?.sandbox),
      prUrl: s?.prUrl || undefined,
      prs: normalizePrs(s?.prs, s?.prUrl),
      attention: Array.isArray(s?.attention) ? s.attention : prevById.get(sessionId)?.attention,
      // The node has no concept of these — carry them over from the row we
      // already had (see the "seen"/"unseen" client-local state doc on
      // SessionSummary.lastSeenAt/finishedAt) so a routine list refresh never
      // resets them.
      lastSeenAt: prevById.get(sessionId)?.lastSeenAt,
      finishedAt: prevById.get(sessionId)?.finishedAt,
    });
  }
  return [...byId.values()];
}

function normalizeSessionStatus(status: unknown, needsAction: boolean, isStreaming: boolean): SessionStatus {
  if (needsAction || status === "needs_action") return "needs_action";
  if (status === "working" || isStreaming) return "working";
  if (status === "saved") return "saved";
  return "idle";
}

export function normalizeModels(list: any): ModelInfo[] {
  if (!Array.isArray(list)) return [];
  return list.map((m) => ({ id: String(m?.id || m?.model || ""), label: m?.label || m?.name, ...m }));
}

export function normalizeThinking(t: any): ThinkingState {
  const levels = Array.isArray(t?.availableThinkingLevels) && t.availableThinkingLevels.length ? t.availableThinkingLevels.map(String) : ["off"];
  return {
    supportsThinking: Boolean(t?.supportsThinking),
    thinkingLevel: String(t?.thinkingLevel || "off"),
    availableThinkingLevels: levels,
  };
}

export function sameModel(a: ModelInfo | null | undefined, b: ModelInfo | null | undefined): boolean {
  if (!a || !b) return false;
  return a.id === b.id && (a as any).provider === (b as any).provider;
}

export function agentLabel(a: RuntimeInfo | undefined): string {
  if (!a) return "";
  return String(a.displayName || a.name || a.id || "");
}

export function upsertApproval(list: ApprovalRequest[], approval: any): ApprovalRequest[] {
  const id = String(approval?.id || "");
  if (!id) return list;
  const next = list.filter((a) => a.id !== id);
  next.push({ id, sessionId: approval?.sessionId, tool: approval?.tool || approval?.toolName, summary: approval?.summary, ...approval });
  return next;
}
