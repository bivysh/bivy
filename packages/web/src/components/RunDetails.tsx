// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// The routable Run details screen (`/runs/:runId`). It is a standalone,
// copy-pasteable destination: a Run URL opened directly on another device loads
// the durable record by id and explains what ran without reading the Session
// transcript. It renders the canonical `Run` projection from @bivy/core (one
// customer Run type over the existing automation/work-item records) — never a
// second projection.
//
// It handles loading, offline, not-found, unauthorized, and stale records
// explicitly, refreshes the durable record after a mutation, and never
// optimistically invents a terminal state. Receipt evidence is not yet
// correlated (Receipt v1), so the Receipt section is shown as unavailable — this
// screen must not overstate a Receipt.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  RunFetchError,
  runFromAutomationRun,
  type AccountAutomationRun,
  type Run,
  type RunReferences,
} from "@bivy/core";

const APPROVAL_LABEL: Record<string, string> = {
  autonomous: "Autonomous",
  risky: "Ask before risky actions",
  always: "Ask before every action",
  never: "Never ask",
};
const SANDBOX_LABEL: Record<string, string> = {
  "read-only": "Read only",
  "workspace-write": "Workspace write",
  "danger-full-access": "Full access",
};
const LIFECYCLE_LABEL: Record<Run["lifecycle"], string> = {
  queued: "Queued",
  running: "Running",
  waiting: "Waiting",
  needs_attention: "Needs attention",
  finished: "Finished",
};

function formatWhen(value?: string): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function formatDuration(ms?: number): string {
  if (typeof ms !== "number" || ms < 0) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m ${rem}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function Row({ k, children }: { k: string; children?: React.ReactNode }) {
  if (children == null || children === false || children === "") return null;
  return (
    <div className="run-sheet-row">
      <span className="k">{k}</span>
      <span className="v">{children}</span>
    </div>
  );
}

function hasAnyReference(refs: RunReferences): boolean {
  return Boolean(refs.branch || refs.commit || refs.pullRequest || refs.checkpoint || refs.artifact);
}

export type RunDetailsStatus = "loading" | "ready" | "not_found" | "unauthorized" | "offline";

export function RunDetails({
  runId,
  load,
  onCancel,
  onClose,
  onOpenSession,
  resolveMachineName,
  isSessionResolvable,
}: {
  runId: string;
  /** Fetch the durable Run record by id. `null` means the Run does not exist for
   *  this account (a non-leaking 404). Throws RunFetchError for unauthorized and
   *  offline so this screen can show each state distinctly. */
  load: (id: string) => Promise<AccountAutomationRun | null>;
  /** Cancel the Run, then this screen refetches the durable record. */
  onCancel?: (id: string) => Promise<void>;
  onClose: () => void;
  /** Navigate to the Run's correlated Session — only wired when resolvable. */
  onOpenSession?: (sessionId: string) => void;
  resolveMachineName?: (machineId: string) => string | undefined;
  /** Whether the correlated Session exists in the current session list. */
  isSessionResolvable?: (sessionId: string) => boolean;
}) {
  const [status, setStatus] = useState<RunDetailsStatus>("loading");
  const [record, setRecord] = useState<AccountAutomationRun | null>(null);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");

  // App passes `load`/`resolveMachineName` as fresh closures every render; keep
  // them in refs so the fetch is keyed only on runId and never storms the
  // endpoint on an unrelated re-render. The Machine name is resolved at render
  // time (below), not baked into the fetched record.
  const loadRef = useRef(load);
  loadRef.current = load;

  const refresh = useCallback(
    async (opts: { keepPrevious?: boolean } = {}) => {
      try {
        const next = await loadRef.current(runId);
        if (next === null) {
          if (opts.keepPrevious) { setStale(true); return; }
          setRecord(null);
          setStatus("not_found");
          return;
        }
        setRecord(next);
        setStatus("ready");
        setStale(false);
      } catch (err) {
        const reason = err instanceof RunFetchError ? err.reason : "error";
        if (reason === "unauthorized") { setStatus("unauthorized"); return; }
        // Offline / transient: keep any record we already showed, but mark it
        // stale rather than inventing a fresh state.
        if (opts.keepPrevious) { setStale(true); return; }
        setStatus("offline");
      }
    },
    [runId],
  );

  useEffect(() => {
    setStatus("loading");
    setStale(false);
    void refresh();
  }, [runId, refresh]);

  const run = useMemo(
    () => (record ? runFromAutomationRun(record, { resolveMachineName }) : null),
    [record, resolveMachineName],
  );

  const cancel = useCallback(async () => {
    if (!onCancel) return;
    setBusy(true);
    setActionError("");
    try {
      await onCancel(runId);
      // Never optimistically invent "cancelled": re-read the durable record.
      await refresh({ keepPrevious: true });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not cancel this Run.");
    } finally {
      setBusy(false);
    }
  }, [onCancel, runId, refresh]);

  return (
    <div className="automations-view run-details" role="dialog" aria-modal="true" aria-label="Run details">
      <header className="automations-view-head">
        <div className="automations-view-head-text">
          <h1 className="automations-view-heading">Run details</h1>
          <p className="automations-view-sub">What this Run did, where it ran, and what remains unknown.</p>
        </div>
        <div className="automations-view-head-actions">
          <button type="button" className="icon-btn" onClick={onClose} title="Close" aria-label="Close run details">✕</button>
        </div>
      </header>

      <div className="automations-view-body run-details-body">
        {status === "loading" && <div className="run-details-state" role="status">Loading this Run…</div>}

        {status === "offline" && (
          <div className="autom-notice warn" role="alert">
            <div className="autom-notice-text">
              <strong>Can&apos;t reach this Run right now</strong>
              <span>You appear to be offline. This Run is safe on the control plane; reconnect to see its current state.</span>
            </div>
            <button type="button" className="btn small" onClick={() => refresh()}>Retry</button>
          </div>
        )}

        {status === "unauthorized" && (
          <div className="autom-notice warn" role="alert">
            <div className="autom-notice-text">
              <strong>Sign in to view this Run</strong>
              <span>Your session isn&apos;t authorized. Sign in again to open this Run.</span>
            </div>
          </div>
        )}

        {status === "not_found" && (
          <div className="run-details-state" role="status">
            <strong>Run not found</strong>
            <p>This Run doesn&apos;t exist or isn&apos;t available on your account.</p>
          </div>
        )}

        {status === "ready" && run && (
          <RunBody
            run={run}
            stale={stale}
            busy={busy}
            actionError={actionError}
            onCancel={onCancel ? cancel : undefined}
            onRefresh={() => refresh()}
            onOpenSession={onOpenSession}
            isSessionResolvable={isSessionResolvable}
          />
        )}
      </div>
    </div>
  );
}

function RunBody({
  run,
  stale,
  busy,
  actionError,
  onCancel,
  onRefresh,
  onOpenSession,
  isSessionResolvable,
}: {
  run: Run;
  stale: boolean;
  busy: boolean;
  actionError: string;
  onCancel?: () => void;
  onRefresh: () => void;
  onOpenSession?: (sessionId: string) => void;
  isSessionResolvable?: (sessionId: string) => boolean;
}) {
  const canCancel = Boolean(onCancel) && run.actions.some((a) => a.kind === "cancel");
  const sessionOpenable = Boolean(run.sessionId) && Boolean(onOpenSession)
    && (isSessionResolvable ? isSessionResolvable(run.sessionId!) : false);
  const agentLine = [run.requested.runtimeId, run.requested.model].filter(Boolean).join(" · ");
  const startedAt = run.timestamps.startedAt ?? run.timestamps.claimedAt;

  return (
    <>
      {stale && (
        <div className="autom-notice warn" role="status">
          <div className="autom-notice-text">
            <strong>Showing the last known state</strong>
            <span>This Run couldn&apos;t be refreshed just now.</span>
          </div>
          <button type="button" className="btn small" onClick={onRefresh}>Refresh</button>
        </div>
      )}

      <div className="run-details-title">{run.title}</div>

      <div className="run-sheet-status">
        <span className={`run-dot`} aria-hidden />
        {LIFECYCLE_LABEL[run.lifecycle]}
        {" · "}
        <span className={`chip outcome-${run.outcome.tone} outcome-kind-${run.outcome.kind}`}>{run.outcome.label}</span>
        {run.attempt > 1 && <span className="run-details-attempt"> · attempt {run.attempt}</span>}
      </div>

      {run.lifecycle === "needs_attention" && (
        <div className="autom-notice warn" role="status">
          <div className="autom-notice-text">
            <strong>Needs attention</strong>
            <span>This Run is waiting on a person before it can continue.</span>
          </div>
        </div>
      )}

      {run.failureSummary && <div className="run-sheet-failure">{run.failureSummary}</div>}

      <div className="run-sheet-rows">
        <Row k="Source">
          {run.source.kind}
          {run.source.reference ? ` · ${run.source.reference}` : ""}
        </Row>
        <Row k="Started">{[formatWhen(startedAt), formatWhen(run.timestamps.completedAt) ? `→ ${formatWhen(run.timestamps.completedAt)}` : ""].filter(Boolean).join(" ")}</Row>
        <Row k="Duration">{formatDuration(run.durationMs)}</Row>
        <Row k="Machine">{run.machine ? run.machine.name || run.machine.id : "Not reported"}</Row>
        <Row k="Session">
          {run.sessionId
            ? sessionOpenable
              ? <button type="button" className="linklike" onClick={() => onOpenSession!(run.sessionId!)}>Open Session</button>
              : <span className="run-details-muted">Correlated Session isn&apos;t available here</span>
            : <span className="run-details-muted">Not correlated</span>}
        </Row>
        {agentLine && <Row k="Ran on">{agentLine}</Row>}
        {run.requested.approvalMode && <Row k="Approvals">{APPROVAL_LABEL[run.requested.approvalMode] ?? run.requested.approvalMode}</Row>}
        {run.requested.sandbox && <Row k="Sandbox">{SANDBOX_LABEL[run.requested.sandbox] ?? run.requested.sandbox}</Row>}
      </div>

      {run.checks.length > 0 && (
        <div className="run-sheet-checks">
          {run.checks.map((c, i) => (
            <span key={`${c.name}-${i}`} className={`chk ${c.status}`}>
              {c.name} {c.status === "passed" ? "✓" : c.status === "failed" ? "✗" : "–"}
            </span>
          ))}
        </div>
      )}

      {hasAnyReference(run.references) && (
        <div className="run-sheet-rows">
          {run.references.pullRequest && (
            <Row k="Pull request"><a href={run.references.pullRequest} target="_blank" rel="noopener">Open pull request</a></Row>
          )}
          {run.references.branch && <Row k="Branch"><code>{run.references.branch}</code></Row>}
          {run.references.commit && <Row k="Commit"><code>{run.references.commit.slice(0, 12)}</code></Row>}
          {run.references.checkpoint && <Row k="Checkpoint"><code>{run.references.checkpoint}</code></Row>}
          {run.references.artifact && (
            <Row k="Artifact"><a href={run.references.artifact} target="_blank" rel="noopener">View artifact</a></Row>
          )}
        </div>
      )}

      <div className="run-details-receipt">
        <span className="k">Receipt</span>
        <span className="v run-details-muted">Unavailable — a Receipt for this Run isn&apos;t ready yet.</span>
      </div>

      {actionError && <div className="run-sheet-failure" role="alert">{actionError}</div>}

      {canCancel && (
        <div className="run-sheet-recovery" role="group" aria-label="Run actions">
          <button type="button" className="btn small recover-cancel" disabled={busy} onClick={onCancel}>
            {busy ? "Cancelling…" : "Cancel Run"}
          </button>
        </div>
      )}
    </>
  );
}
