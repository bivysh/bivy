// SPDX-License-Identifier: AGPL-3.0-only
// Feature-owned automation Run history: filtering, attention alerts, and rows.
import { useMemo, useState } from "react";
import { runFromAutomationRun, type AccountAutomation, type AccountAutomationRun } from "@bivy/core";
import { formatAutomationMoment } from "../automationPresentation.js";
import { projectRunDetail } from "../runDetail.js";
import { Badge, type BadgeTone } from "./Badge.js";

export type RunHistoryFilter = "all" | "active" | "attention" | "parked" | "dead_letter";

export function runHistoryCategory(run: AccountAutomationRun): Exclude<RunHistoryFilter, "attention"> {
  if (run.status === "needs_attention" || run.status === "waiting") return "parked";
  if (run.status === "failed") return "dead_letter";
  if (["pending", "claimed", "running"].includes(run.status)) return "active";
  return "all";
}

function needsAttention(run: AccountAutomationRun): boolean {
  return Boolean(run.attention) || run.status === "needs_attention" || run.status === "failed" || run.notification?.status === "failed";
}

export function RunHistory({
  runs,
  definitions,
  cancelBusyId,
  onRefresh,
  onCancel,
  onOpenRun,
  onOpenSession,
}: {
  runs: AccountAutomationRun[];
  definitions: AccountAutomation[];
  cancelBusyId?: string | null;
  onRefresh: () => void;
  onCancel: (run: AccountAutomationRun) => void;
  onOpenRun?: (runId: string) => void;
  onOpenSession: (sessionId: string) => void;
}) {
  const [filter, setFilter] = useState<RunHistoryFilter>("all");
  const attentionCount = runs.filter(needsAttention).length;
  const visible = useMemo(() => runs.filter((run) => {
    if (filter === "all") return true;
    if (filter === "attention") return needsAttention(run);
    return runHistoryCategory(run) === filter;
  }), [filter, runs]);
  const countFor = (id: RunHistoryFilter): number => {
    if (id === "all") return runs.length;
    if (id === "attention") return attentionCount;
    return runs.filter((run) => runHistoryCategory(run) === id).length;
  };
  const filters: Array<{ id: RunHistoryFilter; label: string }> = [
    { id: "all", label: `All · ${countFor("all")}` },
    { id: "active", label: `Active · ${countFor("active")}` },
    { id: "attention", label: `Attention · ${attentionCount}` },
    { id: "parked", label: `Parked · ${countFor("parked")}` },
    { id: "dead_letter", label: `Dead letter · ${countFor("dead_letter")}` },
  ];

  return (
    <section className="autom-section runs-overview">
      <div className="autom-section-head">
        <div>
          <h2 className="autom-section-label">Recent runs</h2>
          <p className="settings-hint">Live status and recent outcomes.</p>
        </div>
        <div className="autom-section-actions">
          <button type="button" className="btn sm" onClick={onRefresh}>Refresh</button>
        </div>
      </div>
      {attentionCount > 0 && <div className="banner" data-tone="warn" role="alert"><div className="banner-text"><strong>{attentionCount} Run{attentionCount === 1 ? "" : "s"} need attention</strong><span>Review parked work, failed notification delivery, or terminal failures before retrying.</span></div></div>}
      <div className="run-history-filters" role="group" aria-label="Filter Runs">
        {filters.map((item) => <button type="button" key={item.id} className={`btn sm${filter === item.id ? " primary" : ""}`} aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>{item.label}</button>)}
      </div>
      {visible.length === 0 ? <p className="settings-hint autom-empty-hint">No Runs match this filter.</p> : (
        <div className="automation-list">
          {visible.slice(0, 30).map((run) => {
            const detail = projectRunDetail(run);
            const canonical = runFromAutomationRun(run);
            const tone: BadgeTone | undefined = detail.outcome.tone === "success" ? "ok" : detail.outcome.tone === "danger" ? "danger" : detail.outcome.tone === "warning" ? "warn" : undefined;
            const defName = definitions.find((item) => item.id === run.definitionId)?.name;
            const rowMain = <><div className="automation-row-title"><strong>{run.title}</strong><Badge tone={tone}>{detail.outcome.label}</Badge>{canonical.operationalState === "parked" && <Badge tone="warn">Parked</Badge>}{canonical.operationalState === "dead_letter" && <Badge tone="danger">Dead letter</Badge>}</div><div className="settings-hint">{[defName, formatAutomationMoment(run.createdAt), run.triggerKind, detail.checksSummary, `attempt ${canonical.attempt}${canonical.maxAttempts ? `/${canonical.maxAttempts}` : ""}`].filter(Boolean).join(" · ")}</div>{canonical.attemptReason && <div className="settings-hint">{canonical.attemptReason}</div>}{detail.failure && <div className="settings-hint warn-text">{detail.failure}</div>}</>;
            return <div className="automation-row run-row" key={run.id}>
              {onOpenRun ? <button type="button" className="automation-row-main run-row-open" onClick={() => onOpenRun(run.id)}>{rowMain}</button> : <div className="automation-row-main">{rowMain}</div>}
              <div className="automation-row-actions">
                {canonical.actions.some((action) => action.kind === "cancel") && <button type="button" className="btn sm danger" disabled={cancelBusyId === run.id} onClick={() => onCancel(run)}>{cancelBusyId === run.id ? "Cancelling…" : "Cancel"}</button>}
                {canonical.sessionId && <button type="button" className="btn sm primary" onClick={() => onOpenSession(canonical.sessionId!)}>Open session</button>}
                {run.output?.prUrl && <a className="btn sm" href={run.output.prUrl} target="_blank" rel="noreferrer">View PR</a>}
                {onOpenRun && <button type="button" className="run-row-chevron" aria-label={`Open Run details for ${run.title}`} onClick={() => onOpenRun(run.id)}>›</button>}
              </div>
            </div>;
          })}
        </div>
      )}
    </section>
  );
}
