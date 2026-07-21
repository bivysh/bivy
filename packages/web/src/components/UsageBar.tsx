// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useMemo, useState } from "react";
import type { Usage } from "@bivy/core";

function formatResets(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return ` · resets ${d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
}

/**
 * A thin, dismissable usage line under the topbar: cost + token total + the
 * nearest plan-quota window. Rendered from state, not as a chat message.
 */
export function UsageBar({ usage, sessionKey }: { usage: Usage | null; sessionKey: string | null }) {
  const [dismissed, setDismissed] = useState(false);

  // Usage updates continuously during an active turn (cost/tokens tick up).
  // Dismissing used to be keyed on a snapshot of the whole `usage` object, so
  // the very next tick produced a new key and the bar silently reappeared —
  // the ✕ never actually stuck. Dismiss is a per-session choice instead: it
  // holds until the user switches sessions, at which point a fresh bar (for
  // the newly opened session's own usage) is fair to show again.
  useEffect(() => {
    setDismissed(false);
  }, [sessionKey]);

  const summary = useMemo(() => {
    if (!usage) return null;
    const parts: string[] = [];
    if (typeof usage.costUsd === "number") parts.push(`$${usage.costUsd.toFixed(4)}`);
    if (usage.tokens?.total) parts.push(`${usage.tokens.total.toLocaleString()} tokens`);
    const windows = usage.plan?.windows ?? [];
    // Nearest window = highest utilization (closest to a limit).
    const nearest = windows.length
      ? [...windows].sort((a, b) => (b.utilizationPct ?? 0) - (a.utilizationPct ?? 0))[0]
      : null;
    let plan: string | null = null;
    if (nearest) {
      const pct = typeof nearest.utilizationPct === "number" ? `${Math.round(nearest.utilizationPct)}%` : "unknown";
      plan = `${nearest.label}: ${pct} used${formatResets(nearest.resetsAt)}`;
    }
    if (!parts.length && !plan) return null;
    return [parts.join(" · "), plan].filter(Boolean).join("  ·  ");
  }, [usage]);

  if (!summary || dismissed) return null;

  return (
    <div className="usage-bar" role="status">
      <span className="usage-text">{summary}</span>
      <button className="usage-dismiss" aria-label="Dismiss usage" onClick={() => setDismissed(true)}>
        ✕
      </button>
    </div>
  );
}
