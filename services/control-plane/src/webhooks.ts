// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Inbound front-door helpers (E2 GitHub issue webhook, E4 Slack command).
 *
 * Pure and side-effect-free so they unit-test without a running server
 * (test/webhooks.test.ts). The control plane uses these to verify a payload
 * really came from the integration the user configured, then turns it into a
 * WorkItem the owning node pulls. No third-party credentials are stored — only
 * the per-hook secret the user pasted into GitHub/Slack.
 */

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Verify a GitHub `x-hub-signature-256` header ("sha256=<hex>") over the raw body. */
export function verifyGithubSignature(secret: string, rawBody: string | Buffer, header: string | undefined): boolean {
  if (!header) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  return safeEqual(expected, header);
}

export interface ParsedIssueWork {
  title: string;
  body: string;
  repo: string; // "owner/repo"
  issueNumber: number;
  url: string;
  labels: string[];
}

/**
 * Pull the actionable issue out of a GitHub `issues` webhook payload. Returns
 * undefined for events we don't act on (PRs, non-issue events, closed actions).
 * Label-based routing is applied separately via `pickRoutingLabel`.
 */
export function parseGithubIssueEvent(payload: unknown): ParsedIssueWork | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const o = payload as Record<string, any>;
  const action = String(o.action ?? "");
  // Act when an issue is opened/reopened/edited or (re)labelled — i.e. whenever
  // a routing label may have just appeared.
  if (!["opened", "reopened", "edited", "labeled"].includes(action)) return undefined;
  const issue = o.issue;
  if (!issue || typeof issue !== "object" || issue.pull_request) return undefined; // ignore PRs
  const labels: string[] = Array.isArray(issue.labels)
    ? issue.labels.map((l: any) => (typeof l === "string" ? l : l?.name)).filter((n: any): n is string => Boolean(n))
    : [];
  const repo = o.repository?.full_name ? String(o.repository.full_name) : "";
  const issueNumber = Number(issue.number) || 0;
  if (!repo || !issueNumber) return undefined;
  return {
    title: String(issue.title ?? ""),
    body: String(issue.body ?? ""),
    repo,
    issueNumber,
    url: String(issue.html_url ?? ""),
    labels,
  };
}

/**
 * Choose the routing label from an issue's labels: a `bivy` or `bivy/<node>`
 * label (never the claim label). Prefers the most specific (`bivy/<node>`) so a
 * targeted issue routes to that node. Returns undefined if none qualifies.
 */
export function pickRoutingLabel(labels: string[], claimLabel = "bivy:in-progress"): string | undefined {
  const candidates = labels.filter((l) => l !== claimLabel && /^bivy(\/.+)?$/.test(l));
  if (candidates.length === 0) return undefined;
  // Most specific first: a "bivy/<node>" label wins over the bare "bivy".
  candidates.sort((a, b) => (b.includes("/") ? 1 : 0) - (a.includes("/") ? 1 : 0) || b.length - a.length);
  return candidates[0];
}

/**
 * Pull `installation.id` out of a GitHub App webhook payload (as a string).
 * Returned to the node so it can mint an installation token for that install.
 * Undefined for classic per-repo webhooks (no installation object).
 */
export function parseInstallationId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const id = (payload as Record<string, any>).installation?.id;
  return id === undefined || id === null ? undefined : String(id);
}

/** Extract GitHub `@mention` logins from free text (comment/issue body). */
export function extractMentions(text: string): string[] {
  const out: string[] = [];
  // A login mention: `@` not preceded by a word char, then a GitHub username
  // (alphanumerics or single internal hyphens, 1-39 chars).
  const re = /(?:^|[^a-zA-Z0-9_/-])@([a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  return out;
}

export interface ParsedCommentWork {
  title: string; // the issue title (context)
  instruction: string; // the comment body — the actionable request
  repo: string; // "owner/repo"
  issueNumber: number;
  url: string;
  mentions: string[];
  issueLabels: string[];
}

/**
 * Pull an actionable request out of a GitHub `issue_comment` webhook payload.
 * Returns undefined unless the comment (action created/edited) is on an *issue*
 * (PR comments are deferred — they need the reply-to-PR path) and `@`-mentions
 * `triggerLogin` (the bot handle, e.g. "bivy"). The comment body is the
 * instruction; routing is applied separately via `pickCommentRoutingLabel`.
 */
export function parseGithubCommentEvent(payload: unknown, triggerLogin: string): ParsedCommentWork | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const o = payload as Record<string, any>;
  if (!["created", "edited"].includes(String(o.action ?? ""))) return undefined;
  const issue = o.issue;
  const comment = o.comment;
  if (!issue || typeof issue !== "object" || issue.pull_request) return undefined; // issues only
  if (!comment || typeof comment !== "object") return undefined;
  const instruction = String(comment.body ?? "");
  const mentions = extractMentions(instruction);
  const trigger = triggerLogin.trim().replace(/^@/, "").toLowerCase();
  if (!trigger || !mentions.some((m) => m.toLowerCase() === trigger)) return undefined;
  const repo = o.repository?.full_name ? String(o.repository.full_name) : "";
  const issueNumber = Number(issue.number) || 0;
  if (!repo || !issueNumber) return undefined;
  const issueLabels: string[] = Array.isArray(issue.labels)
    ? issue.labels.map((l: any) => (typeof l === "string" ? l : l?.name)).filter((n: any): n is string => Boolean(n))
    : [];
  return {
    title: String(issue.title ?? ""),
    instruction,
    repo,
    issueNumber,
    url: String(comment.html_url ?? issue.html_url ?? ""),
    mentions,
    issueLabels,
  };
}

/**
 * Decide which node a mention-triggered comment routes to. Precedence:
 *   1. An explicit `@<bot> on <node>` directive → `bivy/<node>`.
 *   2. An existing `bivy` / `bivy/<node>` label on the issue.
 *   3. The shared `bivy` label.
 * The directive must follow the mention so ordinary prose ("work on the bug")
 * can't be misread as routing.
 */
export function pickCommentRoutingLabel(instruction: string, issueLabels: string[], triggerLogin = "bivy"): string {
  const trig = triggerLogin.trim().replace(/^@/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = instruction.match(new RegExp(`@${trig}\\s+on\\s+([A-Za-z0-9._-]+)\\b`, "i"));
  if (m) return `bivy/${m[1]}`;
  return pickRoutingLabel(issueLabels) ?? "bivy";
}

/**
 * Decide whether an `issues` event (opened/edited/reopened/labeled) should
 * enqueue work, and under which routing label. An issue routes when EITHER it
 * carries a `bivy` / `bivy/<node>` label, OR its description `@`-mentions the
 * bot handle — the same trigger as an issue comment, just written in the issue
 * body so it fires the moment the issue is created. A body mention honours the
 * `@<bot> on <node>` directive exactly like a comment. Returns undefined when
 * neither a routing label nor a bot mention is present (nothing to enqueue).
 */
export function pickIssueRoutingLabel(issue: ParsedIssueWork, triggerLogin = "bivy"): string | undefined {
  const labelRoute = pickRoutingLabel(issue.labels);
  if (labelRoute) return labelRoute;
  const trigger = triggerLogin.trim().replace(/^@/, "").toLowerCase();
  if (!trigger) return undefined;
  const mentioned = extractMentions(issue.body).some((m) => m.toLowerCase() === trigger);
  if (!mentioned) return undefined;
  return pickCommentRoutingLabel(issue.body, issue.labels, triggerLogin);
}

/**
 * Resolve a routing label against the account's default node. When a label
 * request resolved to only the bare shared `bivy` queue (no explicit
 * `bivy/<node>` label and no `on <node>` directive), and the account has a
 * default node configured, route it there instead — so untagged issues/
 * comments land deterministically on one machine rather than racing across
 * every node currently polling `bivy`. An explicit/targeted label always wins:
 * this only rewrites the exact bare `"bivy"` label.
 */
export function applyDefaultNode(label: string, defaultNode: string | undefined): string {
  if (label === "bivy" && defaultNode?.trim()) return `bivy/${defaultNode.trim()}`;
  return label;
}

/**
 * Verify a Slack request signature (`v0=<hex>` over `v0:timestamp:rawBody`).
 * Rejects stale timestamps (replay) outside `toleranceSec`.
 */
export function verifySlackSignature(
  secret: string,
  timestamp: string | undefined,
  rawBody: string | Buffer,
  header: string | undefined,
  nowSec: number = Math.floor(Date.now() / 1000),
  toleranceSec = 300,
): boolean {
  if (!header || !timestamp) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > toleranceSec) return false;
  const base = `v0:${timestamp}:${typeof rawBody === "string" ? rawBody : rawBody.toString("utf8")}`;
  const expected = "v0=" + createHmac("sha256", secret).update(base).digest("hex");
  return safeEqual(expected, header);
}

export interface ParsedSlackCommand {
  node?: string; // target node label suffix, e.g. "laptop" from "on laptop"
  prompt: string;
}

/**
 * Parse a Slack command body like `on laptop fix the flaky test` into a target
 * node and a prompt. With no leading `on <node>`, the whole text is the prompt
 * (routed to the account's default label).
 */
export function parseSlackCommand(text: string): ParsedSlackCommand {
  const trimmed = (text ?? "").trim();
  const m = trimmed.match(/^on\s+(\S+)\s+([\s\S]+)$/i);
  if (m) return { node: m[1], prompt: m[2].trim() };
  return { prompt: trimmed };
}
