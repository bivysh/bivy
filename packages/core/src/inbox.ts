// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad

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
