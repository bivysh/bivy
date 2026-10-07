// SPDX-License-Identifier: AGPL-3.0-only
// Feature-owned automation Run history: one list, grouped the way the session
// list is — what needs you first, then what's in flight, then by day.
import { Fragment, useMemo, type ReactNode } from "react";
import { runFromAutomationRun, type AccountAutomation, type AccountAutomationRun } from "@bivy/core";
import { formatAutomationMoment } from "../automationPresentation.js";
import { projectRunDetail } from "../runDetail.js";
import { sessionDateGroup } from "../sessionPresentation.js";
import { Badge, type BadgeTone } from "./Badge.js";

const ACTIVE_STATUSES = new Set<AccountAutomationRun["status"]>(["pending", "claimed", "running", "waiting"]);
const ATTENTION_STATUSES = new Set<AccountAutomationRun["status"]>(["needs_attention", "failed"]);
/** Triggers that re-run the same job: the next run of the definition answers
 * whether it is still broken, so an older failure stops asking for attention.
 * Event triggers (GitHub, Linear, webhook) carry a different subject each run. */
const REPEATING_TRIGGERS = new Set(["schedule", "manual"]);
const TONE: Record<string, BadgeTone | undefined> = { success: "ok", danger: "danger", warning: "warn" };

const createdMs = (run: AccountAutomationRun) => Date.parse(run.createdAt) || 0;

/** The heading a Run sits under: "Needs attention", "In progress", or its day. */
export function runGroup(run: AccountAutomationRun, runs: AccountAutomationRun[], now = new Date()): string {
  if (ACTIVE_STATUSES.has(run.status)) return "In progress";
  const flagged = ATTENTION_STATUSES.has(run.status) || Boolean(run.attention);
  const superseded = REPEATING_TRIGGERS.has(run.triggerKind) && runs.some((other) =>
    other.definitionId === run.definitionId && createdMs(other) > createdMs(run));
  if (flagged && !superseded) return "Needs attention";
  return sessionDateGroup(run.createdAt, now);
}

const GROUP_ORDER = ["Needs attention", "In progress", "Today", "Yesterday", "Previous 7 days", "Older"];

export function RunHistory({
  runs,
  definitions,
  onOpenRun,
  onOpenSession,
  waiting,
  compact = false,
}: {
  /** A definition's history: a flat list, no group headings or automation name. */
  compact?: boolean;
  runs: AccountAutomationRun[];
  definitions: AccountAutomation[];
  onOpenRun?: (runId: string) => void;
  onOpenSession: (sessionId: string) => void;
  /** Incoming work no machine has picked up yet; sits after what needs you. */
  waiting?: ReactNode;
}) {
  const groups = useMemo(() => {
    const sorted = [...runs].sort((a, b) => createdMs(b) - createdMs(a));
    if (compact) return [{ label: "", runs: sorted }];
    const byLabel = new Map<string, AccountAutomationRun[]>();
    for (const run of sorted) {
      const label = runGroup(run, sorted);
      byLabel.set(label, [...(byLabel.get(label) ?? []), run]);
    }
    return GROUP_ORDER.filter((label) => byLabel.has(label)).map((label) => ({ label, runs: byLabel.get(label)! }));
  }, [runs, compact]);

  const waitingAt = groups[0]?.label === "Needs attention" ? 1 : 0;
  return (
    <div className="run-history">
      {runs.length === 0 && !waiting && (
        <p className="settings-hint autom-empty-hint">
          {compact ? "No runs yet. Run this automation now, or wait for its trigger." : "No runs yet. Each time an automation fires, its run shows up here."}
        </p>
      )}
      {groups.map((group, index) => (
        <Fragment key={group.label || "all"}>
        {index === waitingAt && waiting}
        <section aria-label={group.label || "Runs"}>
          {group.label && <h2 className="session-group-label">{group.label}</h2>}
          {group.runs.map((run) => {
            const detail = projectRunDetail(run);
            const automation = definitions.find((item) => item.id === run.definitionId)?.name;
            const attention = group.label === "Needs attention";
            const meta = [
              !compact && automation !== run.title ? automation : null,
              formatAutomationMoment(run.createdAt),
            ].filter(Boolean).join(" · ");
            const sessionId = runFromAutomationRun(run).sessionId;
            const open = onOpenRun ? () => onOpenRun(run.id) : sessionId ? () => onOpenSession(sessionId) : undefined;
            return (
              <button type="button" className="automation-history-row" key={run.id} disabled={!open} onClick={open}>
                <span className="automation-history-row-copy">
                  <strong>{run.title}</strong>
                  <span className="settings-hint">{meta}</span>
                  {attention && detail.failure && <span className="settings-hint warn-text run-history-failure">{detail.failure}</span>}
                </span>
                <Badge tone={TONE[detail.outcome.tone]}>{detail.outcome.label}</Badge>
                {open && <span aria-hidden="true">›</span>}
              </button>
            );
          })}
        </section>
        </Fragment>
      ))}
      {groups.length <= waitingAt && waiting}
    </div>
  );
}
