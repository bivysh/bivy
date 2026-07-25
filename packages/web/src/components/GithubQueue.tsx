// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useMemo, useRef, useState } from "react";
import {
  githubIssueRefFromSource,
  isGithubQueueSource,
  ephemeralAdapter,
  PRO_PRICE_LABEL,
  type AccountNode,
  type EphemeralQueueDefault,
  type GithubAppInfo,
  type GithubQueueItem,
  type ProviderKeyInfo,
  type ProviderSize,
} from "@bivy/core";
import { useAppState } from "../store/useStore.js";
import { controller } from "../store/useStore.js";
import { PrBadge, relTime, toMs } from "./SessionList.js";
import { isUnseen, statusClass, statusLabel } from "../sessionStatus.js";

// Cap on the GitHub queue "Sessions" list before a "Show more" link appears
// (issue #531) — with many queue sessions the list otherwise grows unbounded
// and dominates the panel.
const MAX_VISIBLE_SESSIONS = 5;

const EPHEMERAL_TTL_OPTIONS = [
  { v: 30, label: "30 min" },
  { v: 60, label: "1 hour" },
  { v: 180, label: "3 hours" },
];

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
    return rest || "Queue";
  }
  return "";
}

function queueItemSourceLabel(source: string): string {
  return source === "github:comment" ? "@-mention" : source === "github:issue" ? "labelled issue" : source;
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
  onOpenGithubSettings,
}: {
  queue: GithubQueueItem[] | null;
  onRefresh: () => void;
  onPick: (sessionId: string, path?: string, nodeId?: string) => void;
  onOpenGithubSettings: () => void;
}) {
  const { sessions, activeSessionId, prRefreshAllResult, runtimes } = useAppState();
  const canQuery = !controller.direct;

  // The "Run…" agent picker offers the same picker-visible runtimes shown
  // elsewhere (see AgentPicker in Pickers.tsx), built from app state rather than
  // a hard-coded list that duplicated the node's registry. "" = leave the agent
  // to the node's default.
  const agentOptions = useMemo(
    () => [
      { id: "", label: "Node default" },
      ...runtimes.map((r) => ({ id: r.id, label: String(r.displayName || r.name || r.id) })),
    ],
    [runtimes],
  );
  const [appInfo, setAppInfo] = useState<GithubAppInfo | null>(null);
  // The hosted work queue is a paid feature. `null` = still loading (don't flash a
  // paywall); `false` = free account (show the upgrade prompt, hide the queue).
  const [workQueueEnabled, setWorkQueueEnabled] = useState<boolean | null>(null);
  // Free-tier rolling run quota (spans every source, not just the queue). `limit`
  // undefined = unlimited (paid plans); `used` is runs started in the last 7 days.
  // Drives the "N of M runs left this week" banner.
  const [runLimit, setRunLimit] = useState<number | undefined>(undefined);
  const [runsUsed, setRunsUsed] = useState<number>(0);
  const [nodes, setNodes] = useState<AccountNode[]>([]);
  // The queue item whose "Run…" picker is open, plus its in-progress selections.
  const [assignOpenId, setAssignOpenId] = useState<string | null>(null);
  // "node" = dispatch to an already-running node (the pre-#532 behavior);
  // "ephemeral" = provision a short-lived server from saved provider settings.
  const [assignTarget, setAssignTarget] = useState<"node" | "ephemeral">("node");
  const [assignNode, setAssignNode] = useState("");
  const [assignAgent, setAssignAgent] = useState("");
  const [assignModel, setAssignModel] = useState("");
  const [assignBusy, setAssignBusy] = useState(false);
  const [assignErr, setAssignErr] = useState<string | null>(null);
  // Removing a single item / clearing the whole queue.
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
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

  const refreshAllStatus = () => {
    setRefreshingAll(true);
    controller.refreshAllPrStatus();
  };

  // The queue-sessions list is capped at MAX_VISIBLE_SESSIONS by default (issue
  // #531) — this expands it to the full, still updatedAt-desc-sorted list.
  const [showAllSessions, setShowAllSessions] = useState(false);

  // Populate the agent picker from the node's runtime registry (works in direct
  // mode too, so it's not gated on the hosted-account query).
  useEffect(() => {
    controller.listRuntimes();
  }, []);

  // Ephemeral-server assign target: which provider/region/size/TTL to provision
  // with, plus the (optional, saved-on-device) GitHub token the fresh node needs
  // to actually do the work — see controller.runWorkItemOnEphemeral.
  const [ephemeralKeys, setEphemeralKeys] = useState<ProviderKeyInfo[]>([]);
  const [ephemeralProvider, setEphemeralProvider] = useState("");
  const [ephemeralRegion, setEphemeralRegion] = useState("");
  const [ephemeralSizes, setEphemeralSizes] = useState<ProviderSize[]>([]);
  const [ephemeralSize, setEphemeralSize] = useState("");
  const [ephemeralTtl, setEphemeralTtl] = useState(60);
  const [githubTaskToken, setGithubTaskTokenInput] = useState("");
  const [hasGithubTaskToken, setHasGithubTaskToken] = useState(false);
  const [savingToken, setSavingToken] = useState(false);

  // The account's queue-level "auto-provision an ephemeral runner" default. It's
  // configured over in GitHub App settings (GithubPanel); here we only read it to
  // drive the auto-launch behavior below.
  const [ephemeralDefault, setEphemeralDefaultState] = useState<EphemeralQueueDefault | null>(null);
  // Guards a single auto-launch attempt per mount, so a slow/failed launch (or a
  // re-render while one is in flight) can't fire it twice.
  const autoLaunchTried = useRef(false);
  const [autoLaunching, setAutoLaunching] = useState(false);

  useEffect(() => {
    if (!canQuery) return;
    controller.fetchGithubApp().then(setAppInfo).catch(() => setAppInfo(null));
    controller.listNodes().then(setNodes).catch(() => {});
    controller
      .fetchMe()
      .then((m) => {
        setWorkQueueEnabled(Boolean(m?.entitlements?.workQueueEnabled));
        setRunLimit(m?.entitlements?.weeklyRunLimit);
        setRunsUsed(Number(m?.counts?.runsThisWeek ?? 0));
      })
      .catch(() => setWorkQueueEnabled(null));
    controller.listEphemeralKeys().then(setEphemeralKeys).catch(() => {});
    controller.getGithubTaskToken().then((t) => setHasGithubTaskToken(Boolean(t))).catch(() => {});
    controller.getEphemeralQueueDefault().then(setEphemeralDefaultState).catch(() => setEphemeralDefaultState(null));
  }, [canQuery]);

  const configuredProviders = useMemo(() => ephemeralKeys.filter((k) => k.configured), [ephemeralKeys]);

  const openAssign = (item: GithubQueueItem) => {
    setAssignErr(null);
    setAssignOpenId(item.id);
    setAssignTarget("node");
    // Seed from the label (bivy/<node>) and any existing overrides.
    setAssignNode(item.label && item.label.startsWith("bivy/") ? item.label.slice("bivy/".length) : "");
    setAssignAgent(item.runtimeId ?? "");
    setAssignModel(item.model ?? "");
    if (!ephemeralProvider && configuredProviders[0]) {
      const adapter = ephemeralAdapter(configuredProviders[0].id);
      setEphemeralProvider(configuredProviders[0].id);
      if (adapter) {
        setEphemeralRegion(adapter.defaultRegion);
        setEphemeralSizes(adapter.sizes);
        setEphemeralSize(adapter.defaultSize);
      }
    }
  };

  // Live provider catalog for the chosen provider/region, same pattern as the
  // Ephemeral sheet (Ephemeral.tsx) — a saved token unlocks the provider's real,
  // non-deprecated sizes; without one it stays on the static fallback list.
  useEffect(() => {
    if (assignTarget !== "ephemeral" || !ephemeralProvider) return;
    let active = true;
    controller
      .listEphemeralSizes(ephemeralProvider, ephemeralRegion || undefined)
      .then((list) => {
        if (!active || !list.length) return;
        setEphemeralSizes(list);
        setEphemeralSize((cur) => (list.some((s) => s.id === cur) ? cur : (list[0]?.id ?? cur)));
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [assignTarget, ephemeralProvider, ephemeralRegion]);

  const submitAssign = async (id: string) => {
    setAssignErr(null);
    setAssignBusy(true);
    try {
      if (assignTarget === "ephemeral") {
        if (!ephemeralProvider) throw new Error("Choose a provider (add a token in the Ephemeral settings first)");
        await controller.runWorkItemOnEphemeral(id, {
          provider: ephemeralProvider,
          region: ephemeralRegion || undefined,
          size: ephemeralSize || undefined,
          ttlMinutes: ephemeralTtl,
          runtimeId: assignAgent || undefined,
          model: assignModel || undefined,
        });
      } else {
        await controller.assignWorkItem(id, { node: assignNode, runtimeId: assignAgent, model: assignModel });
      }
      setAssignOpenId(null);
      onRefresh();
    } catch (e) {
      setAssignErr(String((e as Error)?.message || e));
    } finally {
      setAssignBusy(false);
    }
  };

  const saveGithubTaskToken = async () => {
    if (!githubTaskToken.trim()) return;
    setSavingToken(true);
    try {
      await controller.setGithubTaskToken(githubTaskToken.trim());
      setGithubTaskTokenInput("");
      setHasGithubTaskToken(true);
    } catch (e) {
      setAssignErr(String((e as Error)?.message || e));
    } finally {
      setSavingToken(false);
    }
  };

  const removeItem = async (id: string) => {
    setDeletingId(id);
    try {
      await controller.deleteWorkItem(id);
      if (assignOpenId === id) setAssignOpenId(null);
      onRefresh();
    } catch {
      /* leave it in place; a Refresh will reconcile */
    } finally {
      setDeletingId(null);
    }
  };
  const clearAll = async () => {
    if (!window.confirm("Remove all waiting items from the queue? Items already picked up keep running.")) return;
    setClearing(true);
    try {
      await controller.clearWorkQueue();
      setAssignOpenId(null);
      onRefresh();
    } catch {
      /* ignore; Refresh reconciles */
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

  // Connected apps with no live node holding their key → nothing will pull their
  // work. An account can have several apps (one per GitHub owner), and they're
  // served independently, so this counts rather than tests a single flag.
  const apps = appInfo?.apps ?? [];
  const unservedApps = apps.filter((a) => a.servedBy === null);
  // No persistent node online at all (any hosted-queue setup, not just GitHub
  // App) — the signal the ephemeral-queue-default watches for.
  const anyNodeOnline = useMemo(() => nodes.some((n) => n.online), [nodes]);
  const defaultProviderConfigured = Boolean(
    ephemeralDefault?.provider && ephemeralKeys.find((k) => k.id === ephemeralDefault.provider)?.configured,
  );

  // Issue #532: when the account's ephemeral-queue-default is enabled, this
  // device has a saved token for the chosen provider, nothing persistent is
  // online, and items are actually waiting, offer to help by provisioning a
  // general-purpose ephemeral runner. Tries once per mount; a failure clears
  // the guard so a later render (e.g. after the user fixes a missing token)
  // can retry rather than wedging silently for the rest of the session.
  useEffect(() => {
    if (!canQuery || !workQueueEnabled) return;
    if (!ephemeralDefault || !ephemeralDefault.enabled || !ephemeralDefault.provider || !defaultProviderConfigured) return;
    if (anyNodeOnline || !waiting || waiting.length === 0) return;
    if (autoLaunchTried.current || autoLaunching) return;
    autoLaunchTried.current = true;
    setAutoLaunching(true);
    controller
      .launchEphemeralQueueWorker({
        provider: ephemeralDefault.provider,
        region: ephemeralDefault.region,
        size: ephemeralDefault.size,
        ttlMinutes: ephemeralDefault.ttlMinutes,
      })
      .catch(() => {
        autoLaunchTried.current = false;
      })
      .finally(() => setAutoLaunching(false));
  }, [canQuery, workQueueEnabled, ephemeralDefault, defaultProviderConfigured, anyNodeOnline, waiting, autoLaunching]);

  return (
      <div className="settings-form">
        {/* The GitHub work queue is included on every plan. The only limit is the
            shared rolling 7-day run cap that spans every source (manual, app,
            queue, ephemeral) — show remaining runs, and prompt an upgrade once the
            window's allowance is spent. */}
        {canQuery && workQueueEnabled !== false && typeof runLimit === "number" && (
          <div className={`banner ${runsUsed >= runLimit ? "warn" : "info"} inline`}>
            {runsUsed >= runLimit ? (
              <>
                Free plan — you've used your {runLimit} free runs this week. Extra runs still
                work for now; capacity returns as your older runs pass 7 days.{" "}
                <button className="link-btn" onClick={() => controller.startCheckout().catch(() => {})}>
                  Upgrade to Pro ({PRO_PRICE_LABEL}) for unlimited →
                </button>
              </>
            ) : (
              <>
                Free plan — {Math.max(0, runLimit - runsUsed)} of {runLimit} runs left this week.{" "}
                <button className="link-btn" onClick={() => controller.startCheckout().catch(() => {})}>
                  Upgrade to Pro ({PRO_PRICE_LABEL}) for unlimited →
                </button>
              </>
            )}
          </div>
        )}

        {canQuery && workQueueEnabled !== false && appInfo && apps.length === 0 && (
          <div className="banner info inline">
            No GitHub App connected yet.{" "}
            <button className="link-btn" onClick={onOpenGithubSettings}>
              Connect one in Settings →
            </button>
          </div>
        )}

        {canQuery && workQueueEnabled !== false && unservedApps.length > 0 && (
          <div className="banner warn inline">
            {unservedApps.length === apps.length
              ? `${apps.length === 1 ? "Your GitHub App is" : "Your GitHub Apps are"} set up, but no online node is running ${apps.length === 1 ? "it" : "them"} — nothing will pick these up.`
              : `${unservedApps.length} of your ${apps.length} GitHub Apps (${unservedApps.map((a) => a.name || a.mention || a.appId).join(", ")}) aren't running on any node — work for those won't be picked up.`}{" "}
            <button className="link-btn" onClick={onOpenGithubSettings}>
              {unservedApps.length === 1 ? "Connect it on a node →" : "Connect them on a node →"}
            </button>
          </div>
        )}

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
            <button className="link-btn" onClick={refreshAllStatus} disabled={refreshingAll} title="Reconcile every session's PR status against GitHub now">
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
                const unseen = isUnseen(s);
                const label = statusLabel(s);
                return (
                  <li key={s.sessionId} className="session-row">
                    <button
                      className={`session-item${s.sessionId === activeSessionId ? " active" : ""}`}
                      onClick={() => onPick(s.sessionId, s.path, s.nodeId)}
                    >
                      <span className={`session-dot ${statusClass(s)}${unseen ? " unseen" : ""}`} title={label} aria-hidden />
                      <span className="sr-only">{label}</span>
                      <span className="session-body">
                        <span className="session-title-row">
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
              <button className="link-btn" onClick={() => setShowAllSessions((v) => !v)}>
                {showAllSessions ? "Show less" : `Show more (${hiddenSessionCount})`}
              </button>
            )}
          </>
        )}

        {canQuery && workQueueEnabled !== false && (
          <>
            <div className="queue-head">
              <h4 className="settings-subhead">
                Waiting to be picked up
                {waiting && waiting.length > 0 && <span className="queue-count">{waiting.length}</span>}
              </h4>
              <div className="queue-head-actions">
                {waiting && waiting.length > 0 && (
                  <button className="link-btn danger" onClick={clearAll} disabled={clearing}>
                    {clearing ? "Clearing…" : "Clear queue"}
                  </button>
                )}
                <button className="link-btn" onClick={onRefresh}>
                  Refresh
                </button>
              </div>
            </div>

            {autoLaunching && (
              <p className="muted" style={{ marginBottom: 10 }}>⚡ Provisioning an ephemeral runner to pick these up…</p>
            )}

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
                    <div className={`queue-card${open ? " open" : ""}`} key={w.id}>
                      <div className="queue-card-row">
                        {w.url ? (
                          <a className="queue-item-main link" href={w.url} target="_blank" rel="noopener noreferrer" title={title}>
                            <span className="queue-item-title">
                              {title}
                              {w.ephemeral && <span className="chip" title="Dispatched to an ephemeral server">⚡ ephemeral</span>}
                            </span>
                            <span className="queue-item-meta">{meta}</span>
                          </a>
                        ) : (
                          <div className="queue-item-main" title={title}>
                            <span className="queue-item-title">
                              {title}
                              {w.ephemeral && <span className="chip" title="Dispatched to an ephemeral server">⚡ ephemeral</span>}
                            </span>
                            <span className="queue-item-meta">{meta}</span>
                          </div>
                        )}
                        <div className="queue-card-actions">
                          <button
                            className={`queue-action-btn${open ? " active" : ""}`}
                            onClick={() => (open ? setAssignOpenId(null) : openAssign(w))}
                            title="Dispatch to a node + agent"
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
                            <span>Target</span>
                            <select value={assignTarget} onChange={(e) => setAssignTarget(e.target.value as "node" | "ephemeral")}>
                              <option value="node">A running node</option>
                              <option value="ephemeral" disabled={configuredProviders.length === 0}>
                                Ephemeral server{configuredProviders.length === 0 ? " (add a provider token first)" : ""}
                              </option>
                            </select>
                          </label>
                          {assignTarget === "node" ? (
                            <label className="queue-run-field">
                              <span>Node</span>
                              <select value={assignNode} onChange={(e) => setAssignNode(e.target.value)}>
                                <option value="">Shared queue (any online node)</option>
                                {nodes.map((n) => (
                                  <option key={n.id} value={n.name || n.id}>{n.name || n.id}</option>
                                ))}
                                {assignNode && !nodes.some((n) => (n.name || n.id) === assignNode) && (
                                  <option value={assignNode}>{assignNode}</option>
                                )}
                              </select>
                            </label>
                          ) : (
                            <>
                              <label className="queue-run-field">
                                <span>Provider</span>
                                <select value={ephemeralProvider} onChange={(e) => setEphemeralProvider(e.target.value)}>
                                  {configuredProviders.map((p) => (
                                    <option key={p.id} value={p.id}>{p.name}</option>
                                  ))}
                                </select>
                              </label>
                              <label className="queue-run-field">
                                <span>Region</span>
                                <select value={ephemeralRegion} onChange={(e) => setEphemeralRegion(e.target.value)}>
                                  {(ephemeralAdapter(ephemeralProvider)?.regions ?? []).map((r) => (
                                    <option key={r.id} value={r.id}>{r.label}</option>
                                  ))}
                                </select>
                              </label>
                              <label className="queue-run-field">
                                <span>Server type</span>
                                <select value={ephemeralSize} onChange={(e) => setEphemeralSize(e.target.value)}>
                                  {ephemeralSizes.map((s) => (
                                    <option key={s.id} value={s.id}>{s.label}</option>
                                  ))}
                                </select>
                              </label>
                              <label className="queue-run-field">
                                <span>Auto-destroy after</span>
                                <select value={ephemeralTtl} onChange={(e) => setEphemeralTtl(Number(e.target.value))}>
                                  {EPHEMERAL_TTL_OPTIONS.map((o) => (
                                    <option key={o.v} value={o.v}>{o.label}</option>
                                  ))}
                                </select>
                              </label>
                              <label className="queue-run-field">
                                <span>GitHub token {hasGithubTaskToken ? "(saved on this device — leave blank to reuse it)" : "(needed to clone/push/open PRs)"}</span>
                                <div className="row-actions">
                                  <input
                                    type="password"
                                    value={githubTaskToken}
                                    placeholder={hasGithubTaskToken ? "•••• saved" : "paste a token"}
                                    onChange={(e) => setGithubTaskTokenInput(e.target.value)}
                                  />
                                  <button className="link-btn" disabled={!githubTaskToken.trim() || savingToken} onClick={saveGithubTaskToken}>
                                    {savingToken ? "Saving…" : "Save"}
                                  </button>
                                </div>
                              </label>
                            </>
                          )}
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
                            <button className="btn" disabled={assignBusy || (assignTarget === "ephemeral" && !ephemeralProvider)} onClick={() => submitAssign(w.id)}>
                              {assignBusy ? "Dispatching…" : assignTarget === "ephemeral" ? "Provision & run" : "Run on node"}
                            </button>
                            {assignErr && <span className="chip err">{assignErr}</span>}
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

        {!canQuery && (
          <p className="muted">
            Direct/local mode has no shared account queue — sessions a labelled issue starts on this node still show above.
          </p>
        )}
      </div>
  );
}
