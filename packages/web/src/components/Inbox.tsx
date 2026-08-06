// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useMemo, useRef, useState } from "react";
import { type InboxItem, type InboxSeverity } from "@bivy/core";
import { useModalEscape } from "../modalStack.js";

// The aggregation/dedup logic (buildInboxItems) lives in @bivy/core — it's a
// pure function over core types (SessionSummary/ApprovalRequest/etc.), so it's
// unit-tested there (packages/core/test/inbox.test.ts) without needing to
// mount any UI, and stays reusable by any future client. Re-exported here so
// existing `from "./Inbox.js"` call sites (App.tsx) don't need to change.
export { buildInboxItems } from "@bivy/core";

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

  // Escape closes — coordinated so only the topmost open layer responds (same
  // convention as Settings/Sheet/AppDialog; see modalStack.ts). Move focus into
  // the dialog on open and restore it to the opener on close so keyboard and
  // screen-reader users aren't left behind the scrim.
  useModalEscape(onClose);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => { opener?.focus?.(); };
  }, []);

  return (
    <section className="inbox" role="dialog" aria-modal="true" aria-labelledby="inbox-title">
      <header className="inbox-head">
        <div><h2 id="inbox-title">Inbox</h2><p>What needs you now, across every machine.</p></div>
        <button ref={closeRef} type="button" className="icon-btn" onClick={onClose} aria-label="Close inbox">×</button>
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
