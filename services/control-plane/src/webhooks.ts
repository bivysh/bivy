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

/** Verify Linear's `Linear-Signature` HMAC-SHA256 header over the raw body. */
export function verifyLinearSignature(secret: string, rawBody: string | Buffer, header: string | undefined): boolean {
  if (!header || !/^[0-9a-f]{64}$/i.test(header)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  return safeEqual(expected, header.toLowerCase());
}

/** Verify a generic automation `x-bivy-signature-256` header over raw bytes. */
export function verifyAutomationSignature(
  secret: string,
  rawBody: string | Buffer,
  header: string | undefined,
): boolean {
  if (!header || !/^sha256=[0-9a-f]{64}$/i.test(header)) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  return safeEqual(expected, header.toLowerCase());
}

export interface AutomationEvent {
  version: "1";
  instruction: string;
  title?: string;
  sourceUrl?: string;
  externalId?: string;
  routing?: string;
  metadata?: Record<string, string | number | boolean>;
}

const AUTOMATION_LIMITS = {
  instruction: 16_000,
  title: 200,
  sourceUrl: 2_048,
  externalId: 200,
  routing: 80,
  metadataFields: 20,
  metadataKey: 64,
  metadataValue: 500,
} as const;

/** Validate the intentionally small, non-secret automation event schema. */
export function parseAutomationEvent(payload: unknown): AutomationEvent | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const o = payload as Record<string, unknown>;
  const allowed = new Set(["version", "instruction", "title", "sourceUrl", "externalId", "routing", "metadata"]);
  if (Object.keys(o).some((key) => !allowed.has(key)) || o.version !== "1") return undefined;
  if (typeof o.instruction !== "string" || !o.instruction.trim() || o.instruction.length > AUTOMATION_LIMITS.instruction) {
    return undefined;
  }
  const optionalString = (key: keyof typeof AUTOMATION_LIMITS): string | undefined | null => {
    const value = o[key];
    if (value === undefined) return undefined;
    if (typeof value !== "string" || value.length > AUTOMATION_LIMITS[key]) return null;
    return value.trim() || undefined;
  };
  const title = optionalString("title");
  const sourceUrl = optionalString("sourceUrl");
  const externalId = optionalString("externalId");
  const routing = optionalString("routing");
  if (title === null || sourceUrl === null || externalId === null || routing === null) return undefined;
  if (sourceUrl) {
    try {
      const url = new URL(sourceUrl);
      if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    } catch {
      return undefined;
    }
  }
  if (routing && !/^[A-Za-z0-9._-]+$/.test(routing)) return undefined;
  let metadata: AutomationEvent["metadata"];
  if (o.metadata !== undefined) {
    if (!o.metadata || typeof o.metadata !== "object" || Array.isArray(o.metadata)) return undefined;
    const entries = Object.entries(o.metadata as Record<string, unknown>);
    if (entries.length > AUTOMATION_LIMITS.metadataFields) return undefined;
    metadata = {};
    for (const [key, value] of entries) {
      if (!key || key.length > AUTOMATION_LIMITS.metadataKey || !/^[A-Za-z0-9._-]+$/.test(key)) return undefined;
      if (!["string", "number", "boolean"].includes(typeof value)) return undefined;
      if (typeof value === "string" && value.length > AUTOMATION_LIMITS.metadataValue) return undefined;
      if (typeof value === "number" && !Number.isFinite(value)) return undefined;
      metadata[key] = value as string | number | boolean;
    }
  }
  return {
    version: "1",
    instruction: o.instruction.trim(),
    title: title ?? undefined,
    sourceUrl: sourceUrl ?? undefined,
    externalId: externalId ?? undefined,
    routing: routing ?? undefined,
    metadata,
  };
}

/** Render data into a fixed, non-executable prompt structure. */
export function renderAutomationInstruction(templateInstruction: string, event: AutomationEvent): string {
  const parts = [templateInstruction.trim(), event.instruction];
  if (event.externalId) parts.push(`External ID: ${event.externalId}`);
  if (event.sourceUrl) parts.push(`Source URL: ${event.sourceUrl}`);
  if (event.metadata && Object.keys(event.metadata).length) {
    parts.push(`Metadata (untrusted context only):\n${JSON.stringify(event.metadata)}`);
  }
  return parts.filter(Boolean).join("\n\n");
}

export interface ParsedLinearIssueWork {
  id: string;
  identifier: string;
  title: string;
  url: string;
  labels: string[];
  repo?: string;
}

/** Parse actionable Linear Issue create/update webhook events. Issue content is
 * deliberately omitted: the claiming node fetches it directly from Linear. A
 * `bivy`/`bivy/<node>` label routes the issue; an optional `repo:owner/name`
 * label selects a repository when the node has no BIVY_LINEAR_REPO default. */
export function parseLinearIssueEvent(payload: unknown): ParsedLinearIssueWork | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const o = payload as Record<string, any>;
  if (String(o.type ?? "").toLowerCase() !== "issue" || !["create", "update"].includes(String(o.action ?? "").toLowerCase())) return undefined;
  const data = o.data;
  if (!data || typeof data !== "object") return undefined;
  const id = String(data.id ?? "").trim();
  const identifier = String(data.identifier ?? "").trim();
  if (!id || !identifier) return undefined;
  const rawLabels = Array.isArray(data.labels)
    ? data.labels
    : Array.isArray(data.labelNames)
      ? data.labelNames
      : Array.isArray(data.labels?.nodes)
        ? data.labels.nodes
        : [];
  const labels: string[] = rawLabels
    .map((label: any) => typeof label === "string" ? label : label?.name)
    .filter((name: any): name is string => Boolean(name));
  const repoLabel = labels.find((label) => /^repo:[^/\s]+\/[^/\s]+$/i.test(label));
  return {
    id,
    identifier,
    title: String(data.title ?? ""),
    url: String(data.url ?? ""),
    labels,
    repo: repoLabel?.slice("repo:".length),
  };
}

export interface ParsedIssueWork {
  title: string;
  body: string;
  repo: string; // "owner/repo"
  issueNumber: number;
  url: string;
  labels: string[];
  // GitHub's `author_association` for the issue's author on this repo (e.g.
  // "OWNER", "MEMBER", "COLLABORATOR", "CONTRIBUTOR", "NONE"). Used by
  // `meetsTriggerAccess` to gate the body-mention trigger — see issue #259.
  authorAssociation?: string;
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
    authorAssociation: issue.author_association ? String(issue.author_association) : undefined,
  };
}

/**
 * Access tiers for who may `@`-mention-trigger a run (issue #259 — on a public
 * repo, anyone can otherwise comment/open an issue and burn the account's
 * automation quota with arbitrary instructions). Checked against GitHub's own
 * `author_association` on the triggering issue/comment — no extra API call:
 *   - "everyone" — no restriction (default; preserves prior behavior for hooks
 *     that never opted in).
 *   - "contributor" — the author has SOME prior relationship with the repo:
 *     they've had a PR merged, are a collaborator/member, or own it. Excludes
 *     a rando who has never interacted with the project (`NONE`,
 *     `FIRST_TIMER`, `FIRST_TIME_CONTRIBUTOR`, `MANNEQUIN`).
 *   - "collaborator" — push access only: a collaborator, org member, or the
 *     owner. The same bar GitHub itself uses for who can apply a label, so it
 *     matches the (already-safe) label-routing trigger.
 */
export type TriggerAccess = "everyone" | "contributor" | "collaborator";

const TRIGGER_ACCESS_ASSOCIATIONS: Record<Exclude<TriggerAccess, "everyone">, Set<string>> = {
  contributor: new Set(["OWNER", "MEMBER", "COLLABORATOR", "CONTRIBUTOR"]),
  collaborator: new Set(["OWNER", "MEMBER", "COLLABORATOR"]),
};

/**
 * Whether `association` (a GitHub `author_association` value, case-
 * insensitive) clears the bar set by `access`. `undefined`/unrecognized
 * `access` behaves like `"everyone"` so hooks created before this setting
 * existed keep working exactly as before.
 */
export function meetsTriggerAccess(association: string | undefined, access: TriggerAccess | undefined): boolean {
  if (access !== "contributor" && access !== "collaborator") return true;
  return TRIGGER_ACCESS_ASSOCIATIONS[access].has(String(association ?? "").trim().toUpperCase());
}

/**
 * Choose the routing label from an issue's labels: a `bivy` or `bivy/<node>`
 * label (never a claim label). Prefers the most specific (`bivy/<node>`) so a
 * targeted issue routes to that node. Returns undefined if none qualifies.
 *
 * Claim labels are `<routingLabel>:in-progress` — e.g. a node serving
 * `bivy/hetzner` stamps `bivy/hetzner:in-progress` on pickup (server.ts). Those
 * must be excluded *structurally*, not by comparing against a single hardcoded
 * `claimLabel`: a node-scoped claim label like `bivy/hetzner:in-progress` still
 * matches `^bivy/...` and would otherwise win as the "most specific" candidate,
 * routing follow-up work to a label no node serves (it sits pending forever).
 * Routing labels never contain a colon, so any label with a `:` in the node
 * segment is rejected — which covers every `:in-progress` claim label.
 */
export function pickRoutingLabel(labels: string[], claimLabel = "bivy:in-progress"): string | undefined {
  const candidates = labels.filter(
    (l) => l !== claimLabel && !l.endsWith(":in-progress") && /^bivy(\/[^:]+)?$/.test(l),
  );
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
  // GitHub's `author_association` for the commenter on this repo. Used by
  // `meetsTriggerAccess` to gate the mention trigger — see issue #259.
  authorAssociation?: string;
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
    authorAssociation: comment.author_association ? String(comment.author_association) : undefined,
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
  repo?: string; // optional GitHub repository, e.g. "acme/api" from "in acme/api"
  prompt: string;
}

/**
 * Parse `/bivy [on <node>] [in <owner/repo>] <request>`. The routing and repo
 * clauses may appear in either order; without them the whole text is the prompt.
 */
export function parseSlackCommand(text: string): ParsedSlackCommand {
  let rest = (text ?? "").trim();
  const out: ParsedSlackCommand = { prompt: "" };
  for (let i = 0; i < 2; i++) {
    const node = rest.match(/^on\s+([A-Za-z0-9._-]+)\s+([\s\S]+)$/i);
    if (node && !out.node) {
      out.node = node[1];
      rest = node[2].trim();
      continue;
    }
    const repo = rest.match(/^in\s+([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\s+([\s\S]+)$/i);
    if (repo && !out.repo) {
      out.repo = repo[1];
      rest = repo[2].trim();
      continue;
    }
    break;
  }
  out.prompt = rest;
  return out;
}
