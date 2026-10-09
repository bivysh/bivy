// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useMemo, useRef, useState } from "react";
import {
  githubIssueRefFromSource,
  isGithubQueueSource,
  type AccountNode,
  type GithubAppInfo,
  type GithubQueueItem,
} from "@bivy/core";
import { useAppState } from "../store/useStore.js";
import { controller } from "../store/useStore.js";
import { PrBadge, RowMark, relTime, toMs } from "./SessionList.js";
import { statusDotState, statusLabel } from "../sessionStatus.js";
import { classifySource } from "../sessionSource.js";
import { ConfirmDialog } from "./AppDialog.js";
import { EPHEMERAL_MACHINES_ENABLED } from "../flags.js";
import { writeClipboard } from "../clipboard.js";
import { Badge, type BadgeTone } from "./Badge.js";
import { isTerminalRun, projectRunDetail } from "../runDetail.js";

// Issue #153: a queue item is worth an "Outcome report" once it has left
// "pending" and picked up at least one timeline event (the control plane
// always stamps a "triggered" event at creation, so this is really "has this
// item been claimed yet").
type EvidenceQueueItem = GithubQueueItem & { events: NonNullable<GithubQueueItem["events"]> };

// Cap on the GitHub queue "Sessions" list before a "Show more" link appears
// (issue #531) — with many queue sessions the list otherwise grows unbounded
// and dominates the panel.
const MAX_VISIBLE_SESSIONS = 5;

/** Human-facing repo/issue (or source) line for a queue-spawned session row —
 *  mirrors SessionList's `sessionMeta`, but for sources that carry no branch
 *  (these sessions run in a disposable worktree, not one the sidebar meta line
 *  would show) the repo/issue is the only useful context. */
function queueSessionMeta(source: string | undefined): string {
  const ref = githubIssueRefFromSource(source);
  if (ref) return `${ref.repo} #${ref.issueNumber}`;
  if (typeof source === "string" && source.startsWith("queue:")) {
    const rest = source.slice("queue:".length);
    if (rest === "slack") return "Slack";
    if (rest === "github:comment") return "GitHub @-mention";
    if (rest === "github:issue") return "GitHub issue";
    if (rest === "linear:issue") return "Linear issue";
    return rest || "Queue";
  }
  return "";
}

function queueItemSourceLabel(source: string): string {
  if (source === "github:comment") return "GitHub @-mention";
  if (source === "github:issue") return "GitHub labelled issue";
  if (source === "linear:issue") return "Linear issue";
  return source;
}

/**
 * The GitHub-app queue, now a Settings page (issue #388): previously these
 * sessions were mixed anonymously into the regular session list, and the
 * account's incoming work items were buried two taps deep in Settings → GitHub
 * App. Both live here now — the sessions the queue has already spawned (works in
 * every mode, including direct/local, since it reads sessions the node already
 * advertises) plus, for hosted accounts, the items still waiting for a node to
 * pick them up. Rendered inside the Settings modal like every other panel rather
 * than as its own separate modal.
 */
export function GithubQueuePanel({
  queue,
  onRefresh,
  onPick,
  onOpenRun,
  onOpenGithubSettings,
  showHistory = true,
}: {
  queue: GithubQueueItem[] | null;
  onRefresh: () => void;
  onPick: (sessionId: string, path?: string, nodeId?: string) => void;
  /** Open the routable Run detail screen (/runs/:runId). A queue item's id is
   *  the Run id (both are the same work_items record). */
  onOpenRun?: (runId: string) => void;
  onOpenGithubSettings: () => void;
  /** The Runs destination already has canonical RunHistory. Keep the legacy
   * session/report projections available for standalone queue consumers only. */
  showHistory?: boolean;
}) {
  const { sessionIndex: { sessions }, activeSession: { activeSessionId }, presentation: { prRefreshAllResult }, catalogs: { runtimes } } = useAppState();
  const cloudMachinesEnabled = EPHEMERAL_MACHINES_ENABLED;
  const canQuery = !controller.direct;

  // The "Run…" agent picker offers the same picker-visible runtimes shown
  // elsewhere (see AgentPicker in Pickers.tsx), built from app state rather than
  // a hard-coded list that duplicated the node's registry. "" = leave the agent
  // to the node's default.
  const agentOptions = useMemo(
    () => [
      { id: "", label: "Machine default" },
      ...runtimes.map((r) => ({ id: r.id, label: String(r.displayName || r.name || r.id) })),
    ],
    [runtimes],
  );
  const [appInfo, setAppInfo] = useState<GithubAppInfo | null>(null);
  const [nodes, setNodes] = useState<AccountNode[]>([]);
  // The queue item whose "Run…" picker is open, plus its in-progress selections.
  const [assignOpenId, setAssignOpenId] = useState<string | null>(null);
  // Unified runner selection for the item: "shared" (any online node),
  // "node:<name>" (a specific persistent node), or "config:<setupId>" (an
  // ephemeral config — a node template provisioned on demand). A persistent
  // node can carry an ephemeral-config fallback for when it's offline; an
  // ephemeral-config primary needs none (it's always provisionable).
  const [assignPrimary, setAssignPrimary] = useState("shared");
  const [assignAgent, setAssignAgent] = useState("");
  const [assignModel, setAssignModel] = useState("");
  const [assignBusy, setAssignBusy] = useState(false);
  const [assignErr, setAssignErr] = useState<string | null>(null);
  // Removing a single item / clearing the whole queue.
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [queueActionErr, setQueueActionErr] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [cancelRun, setCancelRun] = useState<EvidenceQueueItem | null>(null);
  const [cancelBusyId, setCancelBusyId] = useState<string | null>(null);
  // Global "refresh GitHub status" scan (issue #530): reconciles every session
  // this node has tracked that carries PR state, not just the ones listed here
  // — a session that finished or was never reattached keeps whatever PR state
  // it last saw until something like this nudges it. Result is transient store
  // state (`prRefreshAllResult`) fed back from `sessions.pr_refresh_result`.
  const [refreshingAll, setRefreshingAll] = useState(false);

  useEffect(() => {
    if (!refreshingAll) return;
    setRefreshingAll(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- react to the result arriving, not to refreshingAll itself
  }, [prRefreshAllResult]);

  useEffect(() => {
    if (!prRefreshAllResult) return;
    const t = setTimeout(() => controller.store.clearPrRefreshAllResult(), 8000);
    return () => clearTimeout(t);
  }, [prRefreshAllResult]);

  const cancelConfirmedRun = async () => {
    const run = cancelRun;
    if (!run) return;
    setCancelRun(null);
    setQueueActionErr(null);
    setCancelBusyId(run.id);
    try {
      await controller.cancelAutomationRun(run.id);
      onRefresh();
    } catch (e) {
      setQueueActionErr(String((e as Error)?.message || e));
    } finally {
      setCancelBusyId(null);
    }
  };

  const refreshAllStatus = () => {
    setRefreshingAll(true);
    controller.refreshAllPrStatus();
  };

  // The queue-sessions list is capped at MAX_VISIBLE_SESSIONS by default (issue
  // #531) — this expands it to the full, still updatedAt-desc-sorted list.
  const [showAllSessions, setShowAllSessions] = useState(false);

  // Transient "Copied" confirmation for the outcome-report export button
  // (issue #153) — mirrors ConnectRunner/ChatView's copy-feedback convention.
  const [copiedReportId, setCopiedReportId] = useState<string | null>(null);
  const copyReportTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (copyReportTimer.current) clearTimeout(copyReportTimer.current);
  }, []);
  const copyReport = async (item: EvidenceQueueItem) => {
    // Export exactly the sanitized fields the control plane stores — not the
    // whole item object, which also carries queue-routing bookkeeping (label,
    // dedupe keys, ...) that isn't part of the outcome report.
    const report = {
      id: item.id,
      source: item.source,
      status: item.status,
      repo: item.repo,
      issueNumber: item.issueNumber,
      url: item.url,
      createdAt: item.createdAt,
      claimedAt: item.claimedAt,
      startedAt: item.startedAt,
      completedAt: item.completedAt,
      attempt: item.attempt,
      runtimeId: item.runtimeId,
      model: item.model,
      routingReason: item.routingReason,
      approvalMode: item.approvalMode,
      sandbox: item.sandbox,
      output: item.output,
      checks: item.checks,
      events: item.events,
    };
    const ok = await writeClipboard(JSON.stringify(report, null, 2));
    if (!ok) return;
    setCopiedReportId(item.id);
    if (copyReportTimer.current) clearTimeout(copyReportTimer.current);
    copyReportTimer.current = setTimeout(() => setCopiedReportId(null), 1800);
  };

  // Populate the agent picker from the node's runtime registry (works in direct
  // mode too, so it's not gated on the hosted-account query).
  useEffect(() => {
    controller.listRuntimes();
  }, []);

  useEffect(() => {
    if (!canQuery) return;
    controller.fetchGithubApp().then(setAppInfo).catch(() => setAppInfo(null));
    controller.listNodes().then(setNodes).catch(() => {});
  }, [canQuery]);

  // Persistent nodes only — a booted ephemeral machine enrolls as an `eph-…`
  // node, but it's managed by its config/session and is never a manual routing
  // target here (matches ConnectRunner/NodeSwitcher).
  const persistentNodes = useMemo(() => nodes.filter((n) => !n.id.startsWith("eph-")), [nodes]);
  // Decode the unified runner value into a target the dispatch can act on.
  const parseTarget = (v: string): { kind: "shared" } | { kind: "node"; node: string } =>
    v.startsWith("node:") ? { kind: "node", node: v.slice("node:".length) } : { kind: "shared" };
  const primarySel = parseTarget(assignPrimary);
  const primaryNode = primarySel.kind === "node" ? primarySel.node : "";

  const openAssign = (item: GithubQueueItem) => {
    setAssignErr(null);
    setAssignOpenId(item.id);
    // Seed the primary runner from the item's label (bivy/<node> → that node,
    // else the shared queue) and carry over any existing agent/model overrides.
    const node = item.label && item.label.startsWith("bivy/") ? item.label.slice("bivy/".length) : "";
    setAssignPrimary(node ? `node:${node}` : "shared");
    setAssignAgent(item.runtimeId ?? "");
    setAssignModel(item.model ?? "");
  };

  const submitAssign = async (id: string) => {
    setAssignErr(null);
    setAssignBusy(true);
    try {
      await controller.assignWorkItem(id, { node: primarySel.kind === "node" ? primarySel.node : "", runtimeId: assignAgent, model: assignModel });
      setAssignOpenId(null);
      onRefresh();
    } catch (e) {
      setAssignErr(String((e as Error)?.message || e));
    } finally {
      setAssignBusy(false);
    }
  };

  const removeItem = async (id: string) => {
    setDeletingId(id);
    setQueueActionErr(null);
    try {
      await controller.deleteWorkItem(id);
      if (assignOpenId === id) setAssignOpenId(null);
      onRefresh();
    } catch (e) {
      // The button reverting with no message read as if nothing happened —
      // surface why the item is still there instead of failing silently (#140).
      setQueueActionErr(String((e as Error)?.message || e));
    } finally {
      setDeletingId(null);
    }
  };
  const clearAll = async () => {
    setClearing(true);
    setQueueActionErr(null);
    try {
      await controller.clearWorkQueue();
      setAssignOpenId(null);
      onRefresh();
    } catch (e) {
      setQueueActionErr(String((e as Error)?.message || e));
    } finally {
      setClearing(false);
    }
  };

  const queueSessions = useMemo(
    () => [...sessions].filter((s) => isGithubQueueSource(s.source)).sort((a, b) => toMs(b.updatedAt) - toMs(a.updatedAt)),
    [sessions],
  );

  // Cap the rendered list at MAX_VISIBLE_SESSIONS by default; "Show more"
  // expands to the full (still updatedAt-desc) list.
  const visibleQueueSessions = showAllSessions ? queueSessions : queueSessions.slice(0, MAX_VISIBLE_SESSIONS);
  const hiddenSessionCount = queueSessions.length - visibleQueueSessions.length;

  // A pending work item that already has a matching session is claimed/running
  // (or the advertise event just beat the queue poll) — don't show it twice.
  const claimedRefs = useMemo(() => {
    const set = new Set<string>();
    for (const s of queueSessions) {
      const ref = githubIssueRefFromSource(s.source);
      if (ref) set.add(`${ref.repo}#${ref.issueNumber}`);
    }
    return set;
  }, [queueSessions]);

  const waiting = useMemo(() => {
    if (!queue) return queue;
    return queue.filter((w) => {
      if (w.status !== "pending") return false;
      if (w.repo && w.issueNumber != null && claimedRefs.has(`${w.repo}#${w.issueNumber}`)) return false;
      return true;
    });
  }, [queue, claimedRefs]);

  // Issue #153: run detail/outcome reports — every item that has left "pending"
  // (i.e. has a timeline beyond the initial "triggered" event), newest first.
  const reports = useMemo(
    () => (queue ?? [])
      .filter((item): item is EvidenceQueueItem => item.status !== "pending" && Boolean(item.events?.length))
      .sort((a, b) => toMs(b.startedAt ?? b.claimedAt ?? b.createdAt) - toMs(a.startedAt ?? a.claimedAt ?? a.createdAt)),
    [queue],
  );

  // Connected apps with no live node holding their key → nothing will pull their
  // work. An account can have several apps (one per GitHub owner), and they're
  // served independently, so this counts rather than tests a single flag.
  const apps = appInfo?.apps ?? [];
  const unservedApps = apps.filter((a) => a.servedBy === null);
  // Automatic queue provisioning is deliberately absent from this component.
  // Once queue routing points at the cloud, the control plane acquires the
  // account's cloud computer from the deployment. A UI render must never be
  // the causal trigger for a billable machine.

  return (
      <div className="settings-form">
        {canQuery && appInfo && apps.length === 0 && (
          <div className="banner inline" data-tone="neutral">
            Install the hosted Bivy GitHub App, or connect your own app.{" "}
            <button className="btn link" onClick={onOpenGithubSettings}>
              Set up GitHub Apps →
            </button>
          </div>
        )}

        {canQuery && unservedApps.length > 0 && (
          <div className="banner inline" data-tone="warn">
            {unservedApps.length === apps.length
              ? `${apps.length === 1 ? "Your GitHub App is" : "Your GitHub Apps are"} set up, but no online machine is running ${apps.length === 1 ? "it" : "them"} — nothing will pick these up.`
              : `${unservedApps.length} of your ${apps.length} GitHub Apps (${unservedApps.map((a) => a.name || a.mention || a.appId).join(", ")}) aren't running on any machine — work for those won't be picked up.`}{" "}
            <button className="btn link" onClick={onOpenGithubSettings}>
              {unservedApps.length === 1 ? "Connect it on a machine →" : "Connect them on a machine →"}
            </button>
          </div>
        )}

        {showHistory && <>
        <div className="queue-head">
          <h4 className="settings-subhead">Sessions</h4>
          <div className="queue-head-actions">
            {prRefreshAllResult && !refreshingAll && (
              <span className="muted">
                {prRefreshAllResult.error
                  ? prRefreshAllResult.error
                  : `Checked ${prRefreshAllResult.scanned}, updated ${prRefreshAllResult.changed}`}
              </span>
            )}
            <button className="btn link" onClick={refreshAllStatus} disabled={refreshingAll} title="Reconcile every session's PR status against GitHub now">
              {refreshingAll ? "Refreshing GitHub status…" : "Refresh GitHub status"}
            </button>
          </div>
        </div>
        {queueSessions.length === 0 ? (
          <p className="muted">
            No GitHub-triggered sessions yet. Label an issue <code>bivy</code> or @-mention your app to see one here.
          </p>
        ) : (
          <>
            <ul className="queue-session-list">
              {visibleQueueSessions.map((s) => {
                const meta = queueSessionMeta(s.source);
                const label = statusLabel(s);
                const src = classifySource(s.source);
                return (
                  <li key={s.sessionId} className="session-row">
                    <button
                      className={`session-item${s.sessionId === activeSessionId ? " active" : ""}`}
                      onClick={() => onPick(s.sessionId, s.path, s.nodeId)}
                    >
                      <span className="session-body">
                        <span className="session-title-row">
                          <RowMark status={statusDotState(s)} srLabel={`${src.label} · ${label}`} />
                          <span className="session-name">{s.name}</span>
                          <PrBadge prs={s.prs} />
                          {relTime(s.updatedAt) && (
                            <span className="session-age" title={label}>
                              {relTime(s.updatedAt)}
                            </span>
                          )}
                        </span>
                        {meta && <span className="session-meta">{meta}</span>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {queueSessions.length > MAX_VISIBLE_SESSIONS && (
              <button className="btn link" onClick={() => setShowAllSessions((v) => !v)}>
                {showAllSessions ? "Show less" : `Show more (${hiddenSessionCount})`}
              </button>
            )}
          </>
        )}

        </>}

        {/* Embedded in Runs (no history), an empty queue is not worth a section. */}
        {canQuery && (showHistory || Boolean(waiting?.length)) && (
          <>
            <div className="queue-head">
              {/* In the Runs feed this is one more group, headed like the others. */}
              {showHistory ? (
                <h4 className="settings-subhead">
                  Waiting to be picked up
                  {waiting && waiting.length > 0 && <span className="queue-count">{waiting.length}</span>}
                </h4>
              ) : <h2 className="session-group-label">Waiting for a machine</h2>}
              <div className="queue-head-actions">
                {waiting && waiting.length > 0 && (
                  <button className={showHistory ? "btn link danger" : "btn sm"} onClick={() => setConfirmClear(true)} disabled={clearing}>
                    {clearing ? "Clearing…" : "Clear queue"}
                  </button>
                )}
                {showHistory && (
                  <button className="btn link" onClick={onRefresh}>
                    Refresh
                  </button>
                )}
              </div>
            </div>

            {confirmClear && (
              <ConfirmDialog
                title="Clear the queue?"
                message="Remove all waiting items from the queue? Items already picked up keep running."
                confirmLabel="Clear queue"
                danger
                onCancel={() => setConfirmClear(false)}
                onConfirm={() => { setConfirmClear(false); clearAll(); }}
              />
            )}

            {queueActionErr && <div className="banner inline" data-tone="danger">{queueActionErr}</div>}


            {waiting === null ? (
              <p className="muted">—</p>
            ) : waiting.length === 0 ? (
              <p className="muted">Nothing waiting right now.</p>
            ) : (
              <div className="queue-list">
                {waiting.map((w) => {
                  const open = assignOpenId === w.id;
                  const title = w.title || `${w.repo ?? ""}#${w.issueNumber ?? ""}`;
                  const meta = `${w.repo ?? ""}${w.issueNumber ? ` #${w.issueNumber}` : ""} · ${queueItemSourceLabel(w.source)}`;
                  return (
                    <div className={`card queue-card${open ? " open" : ""}`} data-tone="muted" key={w.id}>
                      <div className="queue-card-row">
                        {w.url ? (
                          <a className="queue-item-main link" href={w.url} target="_blank" rel="noopener noreferrer" title={title}>
                            <span className="queue-item-title">
                              {title}
                              {cloudMachinesEnabled && w.ephemeral && <Badge title="Dispatched to an ephemeral server">⚡ ephemeral</Badge>}
                            </span>
                            <span className="queue-item-meta">{meta}</span>
                          </a>
                        ) : (
                          <div className="queue-item-main" title={title}>
                            <span className="queue-item-title">
                              {title}
                              {cloudMachinesEnabled && w.ephemeral && <Badge title="Dispatched to an ephemeral server">⚡ ephemeral</Badge>}
                            </span>
                            <span className="queue-item-meta">{meta}</span>
                          </div>
                        )}
                        <div className="queue-card-actions">
                          <button
                            className={`queue-action-btn${open ? " active" : ""}`}
                            onClick={() => (open ? setAssignOpenId(null) : openAssign(w))}
                            title="Dispatch to a machine + agent"
                          >
                            {open ? "Cancel" : "Run…"}
                          </button>
                          <button
                            className="queue-action-btn danger icon"
                            onClick={() => removeItem(w.id)}
                            disabled={deletingId === w.id}
                            title="Remove from queue"
                            aria-label="Remove from queue"
                          >
                            {deletingId === w.id ? "…" : "×"}
                          </button>
                        </div>
                      </div>
                      {open && (
                        <div className="queue-run">
                          <label className="queue-run-field">
                            <span>Machine</span>
                            <select value={assignPrimary} onChange={(e) => setAssignPrimary(e.target.value)}>
                              <option value="shared">Shared queue (any online machine)</option>
                              {persistentNodes.length > 0 && (
                                <optgroup label="Persistent machines">
                                  {persistentNodes.map((n) => (
                                    <option key={n.id} value={`node:${n.name || n.id}`}>
                                      {n.name || n.id}{n.online ? "" : " (offline)"}
                                    </option>
                                  ))}
                                </optgroup>
                              )}
                              {primarySel.kind === "node" && !persistentNodes.some((n) => (n.name || n.id) === primaryNode) && (
                                <option value={assignPrimary}>{primaryNode}</option>
                              )}
                            </select>
                          </label>
                          <label className="queue-run-field">
                            <span>Agent</span>
                            <select value={assignAgent} onChange={(e) => setAssignAgent(e.target.value)}>
                              {agentOptions.map((a) => (
                                <option key={a.id} value={a.id}>{a.label}</option>
                              ))}
                            </select>
                          </label>
                          <label className="queue-run-field">
                            <span>Model</span>
                            <input
                              value={assignModel}
                              placeholder="optional, e.g. claude-sonnet-5"
                              onChange={(e) => setAssignModel(e.target.value)}
                            />
                          </label>
                          <div className="queue-run-actions">
                            <button className="btn" disabled={assignBusy} onClick={() => submitAssign(w.id)}>
                              {assignBusy ? "Dispatching…" : "Run"}
                            </button>
                            {assignErr && <Badge tone="danger">{assignErr}</Badge>}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}

        {showHistory && canQuery && reports.length > 0 && (
          <>
            <div className="queue-head"><h4 className="settings-subhead">Run details</h4></div>
            {cancelRun && (
              <ConfirmDialog
                title="Cancel Run?"
                message="Request cancellation of this Run? It will remain active until the refreshed durable record reports a terminal result."
                confirmLabel="Cancel Run"
                danger
                onCancel={() => setCancelRun(null)}
                onConfirm={() => void cancelConfirmedRun()}
              />
            )}
            <div className="evidence-list">
              {reports.map((item) => {
                const detail = projectRunDetail(item);
                const outcomeTone: BadgeTone | undefined = detail.outcome.tone === "danger" ? "danger" : detail.outcome.tone === "success" ? "ok" : detail.outcome.tone === "warning" ? "warn" : undefined;
                return (
                  <details className="evidence-report" key={item.id}>
                    <summary>
                      <span>{item.repo}{item.issueNumber ? ` #${item.issueNumber}` : ""} · {queueItemSourceLabel(item.source)}</span>
                      <Badge tone={outcomeTone}>{detail.outcome.label}</Badge>
                    </summary>
                    <div className="evidence-meta">
                      <span>Trigger: {item.triggerKind ?? item.source}</span>
                      {detail.attempt > 1 && <span>Attempt {detail.attempt}</span>}
                      {detail.agent && <span>Agent: {detail.agent}</span>}
                      {detail.checksSummary && <span>Checks: {detail.checksSummary}</span>}
                      {item.routingReason && <span>Routing: {item.routingReason}</span>}
                      {item.sandbox && <span>Sandbox: {item.sandbox}</span>}
                      {item.approvalMode && <span>Approval: {item.approvalMode}</span>}
                      {item.output?.branch && <span>Branch: <code>{item.output.branch}</code></span>}
                      {item.output?.commit && <span>Commit: <code>{item.output.commit.slice(0, 12)}</code></span>}
                      {item.output?.prUrl && <a href={item.output.prUrl} target="_blank" rel="noreferrer">Pull request</a>}
                      {item.output?.artifactUrl && <a href={item.output.artifactUrl} target="_blank" rel="noreferrer">Artifact</a>}
                    </div>
                    {detail.failure && <p className="muted">{detail.failure}</p>}
                    <ol className="evidence-timeline">
                      {item.events.map((event, index) => (
                        <li key={`${event.at}-${index}`}>
                          <time>{new Date(event.at).toLocaleString()}</time>
                          <span>{event.summary}</span>
                          {event.attempt !== undefined && <small>Attempt {event.attempt}</small>}
                        </li>
                      ))}
                    </ol>
                    {item.checks && item.checks.length > 0 && (
                      <ul className="evidence-checks">
                        {item.checks.map((check, index) => (
                          <li key={`${check.name}-${index}`}>{check.name}: {check.status}{check.exitCode !== undefined ? ` (exit ${check.exitCode})` : ""}{check.durationMs !== undefined ? ` · ${(check.durationMs / 1000).toFixed(1)}s` : ""}</li>
                        ))}
                      </ul>
                    )}
                    <div className="row-actions">
                      {onOpenRun && (
                        <button className="btn link" onClick={() => onOpenRun(item.id)}>
                          Open Run details
                        </button>
                      )}
                      {!isTerminalRun(item) && (
                        <button
                          className="btn link danger"
                          disabled={cancelBusyId === item.id}
                          onClick={() => { setQueueActionErr(null); setCancelRun(item); }}
                        >
                          {cancelBusyId === item.id ? "Cancelling…" : "Cancel Run"}
                        </button>
                      )}
                      <button className="btn link" onClick={() => void copyReport(item)}>
                        {copiedReportId === item.id ? "Copied!" : "Copy sanitized Run JSON"}
                      </button>
                    </div>
                  </details>
                );
              })}
            </div>
          </>
        )}

        {!canQuery && (
          <p className="muted">
            Direct/local mode has no shared account queue — sessions a labelled issue starts on this machine still show above.
          </p>
        )}
      </div>
  );
}
