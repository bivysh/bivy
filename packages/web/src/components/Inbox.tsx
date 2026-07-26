// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { useMemo, useState } from "react";
import {
  dedupeInboxItems,
  inboxItemId,
  inboxKindTitle,
  type AccountNode,
  type ApprovalRequest,
  type GithubQueueItem,
  type InboxItem,
  type InboxSeverity,
  type SessionSummary,
  type UserQuestionRequest,
} from "@bivy/core";

const STALE_AFTER_MS = 2 * 60_000;
function timestampMs(value: number | string | undefined): number {
  if (typeof value === "number") return value;
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

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

function severityRank(severity: InboxSeverity): number {
  return { info: 0, warning: 1, error: 2, critical: 3 }[severity];
}

export function Inbox({
  items,
  onOpen,
  onClose,
}: {
  items: InboxItem[];
  onOpen: (item: InboxItem) => void;
  onClose: () => void;
}) {
  const [severity, setSeverity] = useState("");
  const [source, setSource] = useState("");
  const filtered = useMemo(() => items.filter((item) =>
    (!severity || item.severity === severity) && (!source || item.source === source),
  ).sort((a, b) => severityRank(b.severity) - severityRank(a.severity)), [items, severity, source]);

  return (
    <section className="inbox" role="dialog" aria-modal="true" aria-labelledby="inbox-title">
      <header className="inbox-head">
        <div><h2 id="inbox-title">Inbox</h2><p>What needs you now, across every node.</p></div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close inbox">×</button>
      </header>
      <div className="inbox-filters" aria-label="Inbox filters">
        <label>Severity
          <select value={severity} onChange={(event) => setSeverity(event.target.value)}>
            <option value="">All</option><option value="critical">Critical</option>
            <option value="error">Error</option><option value="warning">Warning</option>
          </select>
        </label>
        <label>Source
          <select value={source} onChange={(event) => setSource(event.target.value)}>
            <option value="">All</option><option value="session">Sessions</option>
            <option value="automation">Automation</option><option value="queue">Queue</option>
            <option value="provider">Providers</option>
          </select>
        </label>
      </div>
      <div className="inbox-list" role="list" aria-live="polite">
        {filtered.length === 0 && <div className="inbox-empty">Nothing needs your attention.</div>}
        {filtered.map((item) => (
          <button key={item.id} type="button" className={`inbox-item severity-${item.severity}`} role="listitem" onClick={() => onOpen(item)}>
            <span className="inbox-item-main"><strong>{item.title}</strong><span>{item.detail}</span></span>
            <span className="inbox-item-meta">{item.source}{item.stale ? " · source offline or stale" : ""}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
