// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad

import type { AccountNode, GithubQueueItem } from "./account.js";
import type { ApprovalRequest, SessionSummary, UserQuestionRequest } from "./store.js";

export type InboxItemKind =
  | "approval"
  | "question"
  | "session"
  | "automation"
  | "queue"
  | "provider";
export type InboxSeverity = "info" | "warning" | "error" | "critical";
export type InboxSource = "session" | "automation" | "queue" | "provider";

/** Content-free attention metadata safe to publish in a session advert. */
export interface InboxAdvert {
  id: string;
  kind: "approval" | "question" | "session" | "automation";
  severity: InboxSeverity;
  createdAt: string;
  updatedAt?: string;
}

export interface InboxItem {
  /** Stable across refreshes: source + owner + unresolved condition id. */
  id: string;
  kind: InboxItemKind;
  severity: InboxSeverity;
  source: InboxSource;
  state: "unresolved" | "resolved";
  nodeId?: string;
  sessionId?: string;
  runId?: string;
  queueItemId?: string;
  providerId?: string;
  /** Source-owned card/condition id used by deep links. */
  targetId?: string;
  title: string;
  detail?: string;
  createdAt: string;
  updatedAt: string;
  /** True when the owning node is offline or its advert is old. */
  stale?: boolean;
}

export function inboxItemId(source: InboxSource, ownerId: string, conditionId: string): string {
  return `${source}:${ownerId}:${conditionId}`;
}

export function isInboxAdvert(value: unknown): value is InboxAdvert {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === "string"
    && ["approval", "question", "session", "automation"].includes(String(v.kind))
    && ["info", "warning", "error", "critical"].includes(String(v.severity))
    && typeof v.createdAt === "string";
}

export function inboxKindTitle(kind: InboxItemKind): string {
  switch (kind) {
    case "approval": return "Approval needed";
    case "question": return "Question waiting";
    case "automation": return "Automation needs attention";
    case "queue": return "Queue item needs assignment";
    case "provider": return "Provider is blocking work";
    default: return "Session needs attention";
  }
}

/** Last writer wins by updatedAt; this is also the duplicate-suppression boundary. */
export function dedupeInboxItems(items: InboxItem[]): InboxItem[] {
  const byId = new Map<string, InboxItem>();
  for (const item of items) {
    const prior = byId.get(item.id);
    if (!prior || Date.parse(item.updatedAt) >= Date.parse(prior.updatedAt)) byId.set(item.id, item);
  }
  return [...byId.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

/** A live node's advert goes stale (rather than simply absent) once it's older
 *  than this — a node that's gone quiet without an explicit offline flag
 *  should still read as "may not be current" rather than silently trusted. */
const STALE_AFTER_MS = 2 * 60_000;

function timestampMs(value: number | string | undefined): number {
  if (typeof value === "number") return value;
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Normalize every source of attention (session/account adverts, live
 * approval + question pushes, the GitHub/Slack work queue, and node provider
 * auth) into one deduplicated, content-free InboxItem[]. Pure and
 * framework-agnostic so it's unit-testable without mounting any UI, and
 * reusable by any future client (web today, Expo later — see #152).
 *
 * Deliberately reads only routing/lifecycle fields (ids, timestamps,
 * severities, session/node/queue linkage) — never prompt, transcript, or tool
 * body content, per the "no decrypted content in the control plane" rule.
 */
export function buildInboxItems(input: {
  sessions: SessionSummary[];
  approvals: ApprovalRequest[];
  questions: UserQuestionRequest[];
  nodes: AccountNode[];
  queue: GithubQueueItem[];
  now?: number;
}): InboxItem[] {
  const now = input.now ?? Date.now();
  const nodes = new Map(input.nodes.map((node) => [node.id, node]));
  const sessions = new Map(input.sessions.map((session) => [session.sessionId, session]));
  const items: InboxItem[] = [];

  for (const session of input.sessions) {
    for (const advert of session.attention ?? []) {
      const source = advert.kind === "automation" ? "automation" : "session";
      const updatedAt = advert.updatedAt || advert.createdAt;
      const node = session.nodeId ? nodes.get(session.nodeId) : undefined;
      const stale = node?.online === false || (session.updatedAt ? now - timestampMs(session.updatedAt) > STALE_AFTER_MS : false);
      items.push({
        id: inboxItemId(source, session.sessionId, advert.id),
        kind: advert.kind,
        severity: advert.severity,
        source,
        state: "unresolved",
        nodeId: session.nodeId,
        sessionId: session.sessionId,
        targetId: advert.id,
        ...(advert.kind === "automation" ? { runId: session.sessionId } : {}),
        title: inboxKindTitle(advert.kind),
        detail: session.name,
        createdAt: advert.createdAt,
        updatedAt,
        stale,
      });
    }
  }

  // Live node events can arrive before the next control-plane advert. Merge them
  // by the same stable condition id; dedupeInboxItems keeps only one row.
  for (const approval of input.approvals) {
    const session = approval.sessionId ? sessions.get(approval.sessionId) : undefined;
    const createdAt = new Date(Number(approval.createdAt) || now).toISOString();
    items.push({
      id: inboxItemId("session", approval.sessionId || "global", approval.id),
      kind: "approval", severity: approval.risk === "critical" ? "critical" : "warning",
      source: "session", state: "unresolved", nodeId: session?.nodeId,
      sessionId: approval.sessionId, title: inboxKindTitle("approval"),
      targetId: approval.id,
      detail: session?.name, createdAt, updatedAt: createdAt,
    });
  }
  for (const question of input.questions) {
    const session = question.sessionId ? sessions.get(question.sessionId) : undefined;
    const createdAt = new Date(Number(question.createdAt) || now).toISOString();
    items.push({
      id: inboxItemId("session", question.sessionId || "global", question.id),
      kind: "question", severity: "warning", source: "session", state: "unresolved",
      nodeId: session?.nodeId, sessionId: question.sessionId,
      targetId: question.id,
      title: inboxKindTitle("question"), detail: session?.name,
      createdAt, updatedAt: createdAt,
    });
  }
  for (const queueItem of input.queue) {
    if (queueItem.status !== "pending") continue;
    items.push({
      id: inboxItemId("queue", queueItem.id, "assignment"),
      kind: "queue", severity: "warning", source: "queue", state: "unresolved",
      queueItemId: queueItem.id, title: inboxKindTitle("queue"), detail: queueItem.title,
      createdAt: queueItem.createdAt, updatedAt: queueItem.createdAt,
    });
  }
  for (const node of input.nodes) {
    for (const provider of node.providers ?? []) {
      if (!provider.configured || !provider.expiresAt || provider.expiresAt > now) continue;
      const createdAt = new Date(provider.expiresAt).toISOString();
      items.push({
        id: inboxItemId("provider", node.id, provider.id),
        kind: "provider", severity: "error", source: "provider", state: "unresolved",
        nodeId: node.id, providerId: provider.id, title: inboxKindTitle("provider"),
        detail: `${provider.name || provider.id} on ${node.name || node.id} needs authentication`,
        createdAt, updatedAt: createdAt, stale: node.online === false,
      });
    }
  }
  return dedupeInboxItems(items);
}
