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
import { ConfirmDialog } from "./AppDialog.js";
import { StatusDot, type StatusDotState } from "./StatusDot.js";
import { Badge } from "./Badge.js";
import {
  RunFetchError,
  receiptV1FromRun,
  receiptV1Json,
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
const LIFECYCLE_STATUS: Record<Run["lifecycle"], StatusDotState> = {
  queued: "idle",
  running: "working",
  waiting: "idle",
  needs_attention: "needs-action",
  finished: "idle",
};

function formatWhen(value?: string): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function formatUsage(usage: Run["usage"]): string {
  if (!usage) return "";
  const tokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  const bits = [tokens ? `${tokens.toLocaleString()} tokens` : "", typeof usage.costUsd === "number" ? `$${usage.costUsd.toFixed(4)}` : ""];
  return bits.filter(Boolean).join(" · ");
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
  onRetry,
  onClose,
  onOpenSession,
  onReauthenticate,
  resolveMachineName,
  isSessionResolvable,
  onReceiptReviewed,
}: {
  runId: string;
  /** Fetch the durable Run record by id. `null` means the Run does not exist for
   *  this account (a non-leaking 404). Throws RunFetchError for unauthorized and
   *  offline so this screen can show each state distinctly. */
  load: (id: string) => Promise<AccountAutomationRun | null>;
  /** Cancel the Run, then this screen refetches the durable record. */
  onCancel?: (id: string) => Promise<void>;
  /** Start another durable attempt, then refetch instead of inventing state. */
  onRetry?: (id: string) => Promise<void>;
  onClose: () => void;
  /** Navigate to the Run's correlated Session — only wired when resolvable. */
  onOpenSession?: (sessionId: string) => void;
  /** Open provider-specific auth on the Machine that executed this Run. */
  onReauthenticate?: (provider: string, machineId: string | undefined, reason: string) => Promise<void>;
  resolveMachineName?: (machineId: string) => string | undefined;
  /** Whether the correlated Session exists in the current session list. */
  isSessionResolvable?: (sessionId: string) => boolean;
  /** Content-free analytics hook; deliberately receives no Run identifier. */
  onReceiptReviewed?: () => void;
}) {
  const [status, setStatus] = useState<RunDetailsStatus>("loading");
  const [record, setRecord] = useState<AccountAutomationRun | null>(null);
  const [stale, setStale] = useState(false);
  const [busyAction, setBusyAction] = useState<"cancel" | "retry" | "reauthenticate" | null>(null);
  const [actionError, setActionError] = useState("");
  const [confirmCancel, setConfirmCancel] = useState(false);
  const reviewedReceipt = useRef(false);

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
    reviewedReceipt.current = false;
    setStatus("loading");
    setStale(false);
    void refresh();
  }, [runId, refresh]);

  const run = useMemo(
    () => (record ? runFromAutomationRun(record, { resolveMachineName }) : null),
    [record, resolveMachineName],
  );

  useEffect(() => {
    if (status !== "ready" || !run || reviewedReceipt.current) return;
    reviewedReceipt.current = true;
    onReceiptReviewed?.();
  }, [onReceiptReviewed, run, status]);

  const cancel = useCallback(async () => {
    if (!onCancel) return;
    setBusyAction("cancel");
    setActionError("");
    try {
      await onCancel(runId);
      // Never optimistically invent "cancelled": re-read the durable record.
      await refresh({ keepPrevious: true });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not cancel this Run.");
    } finally {
      setBusyAction(null);
    }
  }, [onCancel, runId, refresh]);
  const retry = useCallback(async () => {
    if (!onRetry) return;
    setBusyAction("retry");
    setActionError("");
    try {
      await onRetry(runId);
      await refresh({ keepPrevious: true });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not retry this Run.");
    } finally {
      setBusyAction(null);
    }
  }, [onRetry, runId, refresh]);
  const reauthenticate = useCallback(async (provider: string, machineId: string | undefined, reason: string) => {
    if (!onReauthenticate) return;
    setBusyAction("reauthenticate");
    setActionError("");
    try {
      await onReauthenticate(provider, machineId, reason);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not open model sign-in.");
    } finally {
      setBusyAction(null);
    }
  }, [onReauthenticate]);

  return (
    <div className="automations-view run-details" role="dialog" aria-modal="true" aria-label="Run details">
      <header className="automations-view-head">
        <div className="automations-view-head-text">
          <h1 className="automations-view-heading">Run details</h1>
          <p className="automations-view-sub">What this Run did, where it ran, and what remains unknown.</p>
        </div>
        <div className="automations-view-head-actions">
          <button type="button" className="btn ghost icon run-details-close" onClick={onClose} title="Back" aria-label="Close run details"><span aria-hidden="true">‹</span><span>Back</span></button>
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
            <button type="button" className="btn sm" onClick={() => refresh()}>Retry</button>
          </div>
        )}

        {status === "unauthorized" && (
          <div className="autom-notice warn" role="alert">
            <div className="autom-notice-text">
              <strong>Sign in to view this Run</strong>
              <span>Your session isn&apos;t authorized. Sign in again to open this Run.</span>
            </div>
            <button type="button" className="btn primary" onClick={() => window.location.assign("/")}>Sign in</button>
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
            busyAction={busyAction}
            actionError={actionError}
            onCancel={onCancel ? () => setConfirmCancel(true) : undefined}
            onRetry={onRetry ? retry : undefined}
            onRefresh={() => refresh()}
            onOpenSession={onOpenSession}
            onReauthenticate={onReauthenticate ? reauthenticate : undefined}
            isSessionResolvable={isSessionResolvable}
          />
        )}
      </div>
      {confirmCancel && (
        <ConfirmDialog
          title="Cancel run?"
          message="The agent may take a moment to stop. This page will refresh from the durable run record."
          confirmLabel="Cancel run"
          danger
          onCancel={() => setConfirmCancel(false)}
          onConfirm={() => { setConfirmCancel(false); void cancel(); }}
        />
      )}
    </div>
  );
}

function RunBody({
  run,
  stale,
  busyAction,
  actionError,
  onCancel,
  onRetry,
  onRefresh,
  onOpenSession,
  onReauthenticate,
  isSessionResolvable,
}: {
  run: Run;
  stale: boolean;
  busyAction: "cancel" | "retry" | "reauthenticate" | null;
  actionError: string;
  onCancel?: () => void;
  onRetry?: () => void;
  onRefresh: () => void;
  onOpenSession?: (sessionId: string) => void;
  onReauthenticate?: (provider: string, machineId: string | undefined, reason: string) => Promise<void>;
  isSessionResolvable?: (sessionId: string) => boolean;
}) {
  const canCancel = Boolean(onCancel) && run.actions.some((a) => a.kind === "cancel");
  const canRetry = Boolean(onRetry) && run.actions.some((a) => a.kind === "retry");
  const inspectChecks = run.actions.some((a) => a.kind === "inspect_checks");
  const reviewSession = run.actions.some((a) => a.kind === "review_session");
  const reauthenticate = run.actions.find((a) => a.kind === "reauthenticate" && a.provider);
  const sessionOpenable = Boolean(run.sessionId) && Boolean(onOpenSession)
    && (isSessionResolvable ? isSessionResolvable(run.sessionId!) : false);
  const agentLine = [run.requested.runtimeId, run.requested.model].filter(Boolean).join(" · ");
  const startedAt = run.timestamps.startedAt ?? run.timestamps.claimedAt;
  const receipt = useMemo(() => receiptV1FromRun(run, new Date().toISOString()), [run]);
  const checksRef = useRef<HTMLDivElement>(null);
  const startReauthentication = useCallback(async () => {
    if (!onReauthenticate || !reauthenticate?.provider) return;
    await onReauthenticate(reauthenticate.provider, run.machine?.id, run.failureSummary || "Authentication failed");
  }, [onReauthenticate, reauthenticate, run.failureSummary, run.machine?.id]);
  const exportReceipt = useCallback(() => {
    const blob = new Blob([`${receiptV1Json(receipt)}\n`], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${receipt.receiptId}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }, [receipt]);

  return (
    <>
      {stale && (
        <div className="autom-notice warn" role="status">
          <div className="autom-notice-text">
            <strong>Showing the last known state</strong>
            <span>This Run couldn&apos;t be refreshed just now.</span>
          </div>
          <button type="button" className="btn sm" onClick={onRefresh}>Refresh</button>
        </div>
      )}

      <div className="run-details-title">{run.title}</div>

      <div className="run-sheet-status">
        <StatusDot status={LIFECYCLE_STATUS[run.lifecycle]} />
        {LIFECYCLE_LABEL[run.lifecycle]}
        {" · "}
        <Badge tone={run.outcome.tone === "success" ? "ok" : run.outcome.tone === "warning" ? "warn" : run.outcome.tone === "danger" ? "danger" : undefined}>{run.outcome.label}</Badge>
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
              ? <button type="button" className="btn link" onClick={() => onOpenSession!(run.sessionId!)}>Open Session</button>
              : <span className="run-details-muted">Correlated Session isn&apos;t available here</span>
            : <span className="run-details-muted">Not correlated</span>}
        </Row>
        {agentLine && <Row k="Ran on">{agentLine}</Row>}
        {run.requested.approvalMode && <Row k="Approvals">{APPROVAL_LABEL[run.requested.approvalMode] ?? run.requested.approvalMode}</Row>}
        {run.requested.sandbox && <Row k="Sandbox">{SANDBOX_LABEL[run.requested.sandbox] ?? run.requested.sandbox}</Row>}
        <Row k="Attempt">{run.attempt}{run.maxAttempts ? ` of ${run.maxAttempts}` : ""}{run.attemptReason ? ` · ${run.attemptReason}` : ""}</Row>
        <Row k="Usage / cost">{formatUsage(run.usage) || "Not reported by the provider"}</Row>
        <Row k="Notification">
          {run.notification
            ? `${run.notification.status.replace("_", " ")}${run.notification.channel ? ` · ${run.notification.channel}` : ""}${run.notification.reason ? ` · ${run.notification.reason}` : ""}`
            : "Not reported"}
        </Row>
        <Row k="Next action">{run.nextAction?.label ?? "No operator action available"}</Row>
      </div>

      {run.timeline.length > 0 && (
        <section className="run-timeline" aria-labelledby="run-timeline-heading">
          <h2 id="run-timeline-heading">Lifecycle</h2>
          <ol>
            {run.timeline.map((milestone, index) => (
              <li key={`${milestone.stage}-${milestone.at}-${index}`}>
                <span className="run-timeline-dot" aria-hidden />
                <div>
                  <strong>{milestone.stage.replaceAll("_", " ")}</strong>
                  <span>{formatWhen(milestone.at)}{milestone.attempt ? ` · attempt ${milestone.attempt}` : ""}</span>
                  <p>{milestone.summary}</p>
                  {milestone.evidenceRef && <code>{milestone.evidenceRef}</code>}
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}

      {run.checks.length > 0 && (
        <div className="run-sheet-checks" ref={checksRef} tabIndex={-1}>
          {run.checks.map((c, i) => (
            <Badge key={`${c.name}-${i}`} tone={c.status === "passed" ? "ok" : c.status === "failed" ? "danger" : undefined}>
              {c.name} {c.status === "passed" ? "✓" : c.status === "failed" ? "✗" : "–"}
            </Badge>
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

      {run.operationalReferences.length > 0 && (
        <div className="run-sheet-rows">
          {run.operationalReferences.map((reference, index) => (
            <Row k={reference.kind[0]!.toUpperCase() + reference.kind.slice(1)} key={`${reference.kind}-${reference.ref}-${index}`}>
              {reference.url ? <a href={reference.url} target="_blank" rel="noopener">{reference.ref}</a> : <code>{reference.ref}</code>}
            </Row>
          ))}
        </div>
      )}

      <div className="run-sheet-rows run-details-receipt">
        <div className="run-sheet-row">
          <span className="k">Receipt</span>
          <span className="v">
            {receipt.completeness === "complete" ? "Complete" : `Partial · ${receipt.missingEvidence.length} evidence gap${receipt.missingEvidence.length === 1 ? "" : "s"}`}
            {" "}
            <button type="button" className="btn link" onClick={exportReceipt}>Export JSON</button>
          </span>
        </div>
        {receipt.observationLimitations.slice(0, 3).map((limitation) => (
          <div className="run-sheet-row" key={limitation.code}>
            <span className="k">Limitation</span>
            <span className="v run-details-muted">{limitation.message}</span>
          </div>
        ))}
      </div>

      {actionError && <div className="run-sheet-failure" role="alert">{actionError}</div>}

      {(canCancel || canRetry || inspectChecks || (reviewSession && sessionOpenable) || (reauthenticate && onReauthenticate)) && (
        <div className="run-sheet-recovery" role="group" aria-label="Run actions">
          {inspectChecks && (
            <button type="button" className="btn sm primary recover-checks" onClick={() => { checksRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }); checksRef.current?.focus(); }}>
              Review failed checks
            </button>
          )}
          {reauthenticate && onReauthenticate && (
            <button type="button" className="btn sm primary recover-auth" disabled={busyAction !== null} onClick={() => void startReauthentication()}>
              {busyAction === "reauthenticate" ? "Connecting…" : reauthenticate.label}
            </button>
          )}
          {reviewSession && sessionOpenable && (
            <button type="button" className="btn sm primary recover-review" onClick={() => onOpenSession!(run.sessionId!)}>
              Review Session
            </button>
          )}
          {canRetry && (
            <button type="button" className="btn sm primary recover-retry" disabled={busyAction !== null} onClick={onRetry}>
              {busyAction === "retry" ? "Retrying…" : "Retry Run"}
            </button>
          )}
          {canCancel && (
            <button type="button" className="btn sm recover-cancel" disabled={busyAction !== null} onClick={onCancel}>
              {busyAction === "cancel" ? "Cancelling…" : "Cancel Run"}
            </button>
          )}
        </div>
      )}
    </>
  );
}
