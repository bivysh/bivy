// SPDX-License-Identifier: AGPL-3.0-only
//
// Sole connection hub for GitHub App / Linear / Slack. Multi-app lifecycle
// (add, reconnect key, disconnect), default machine, and who-can-trigger all
// live here — Settings only deep-links into this sheet.
import { useCallback, useEffect, useState, type ChangeEvent } from "react";
import {
  type AccountNode,
  type AppState,
  type GithubAppEntry,
  type GithubAppInfo,
  type LinearHook,
  type SlackHook,
  type HostedProvisioningStatus,
  connectLinearHook,
  connectSlackHook,
  disconnectLinearHook,
  disconnectSlackHook,
  fetchLinearHook,
  fetchSlackHook,
  fetchHostedProvisioning,
} from "@bivy/core";
import { controller } from "../store/controller.js";

export type SourceSetupFocus = "github" | "linear" | "slack" | "work-queue";

/** Flag the return-from-GitHub redirect so the controller finishes the handshake. */
function markGithubAppPending(): void {
  try {
    sessionStorage.setItem("bivy.githubAppPending", "1");
  } catch {
    /* private mode */
  }
}

function appKey(entry: GithubAppEntry): string {
  return entry.appId || entry.hookId || entry.slug || "";
}

function installHref(entry: GithubAppEntry): string {
  return entry.installUrl
    || (entry.slug ? `https://github.com/apps/${entry.slug}/installations/new` : "https://github.com/settings/installations");
}

function titleFor(focus: SourceSetupFocus): string {
  switch (focus) {
    case "linear": return "Connect Linear";
    case "slack": return "Connect Slack";
    case "github": return "Connect GitHub";
    default: return "Work issues into PRs";
  }
}

function leadFor(focus: SourceSetupFocus): string {
  switch (focus) {
    case "linear":
      return "Label a Linear issue and a machine you own opens the pull request. This is the only place to connect or disconnect Linear.";
    case "slack":
      return "Turn a Slack slash command into an unattended run. Connect, copy the Request URL, or disconnect — all here.";
    case "github":
      return "Add, install, reconnect, or disconnect GitHub Apps here. One account can hold several apps (personal + orgs).";
    default:
      return "Connect the sources that start work on your machines. Lifecycle stays in Automations — not Settings.";
  }
}

export function WorkQueueSetupSheet({
  state,
  onClose,
  focus = "work-queue",
  onChanged,
}: {
  state: AppState;
  onClose: () => void;
  /** @deprecated Connections no longer bounce to Settings. */
  onOpenFullSettings?: (view?: "github" | "linear" | "slack" | "webhooks") => void;
  /** Which source to emphasise. work-queue shows GitHub + Linear together. */
  focus?: SourceSetupFocus;
  /** Parent refreshes live source chips after a successful connect. */
  onChanged?: () => void;
}) {
  const canQuery = !controller.direct;
  const [info, setInfo] = useState<GithubAppInfo | null>(null);
  const [nodes, setNodes] = useState<AccountNode[]>([]);
  const [linear, setLinear] = useState<LinearHook | null>(null);
  const [slack, setSlack] = useState<SlackHook | null>(null);
  const [hosted, setHosted] = useState<HostedProvisioningStatus | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const [org, setOrg] = useState("");
  const [defaultNode, setDefaultNode] = useState("");
  const [savingNode, setSavingNode] = useState(false);
  const [nodeMsg, setNodeMsg] = useState<string | null>(null);
  const [showExisting, setShowExisting] = useState(false);
  const [ceAppId, setCeAppId] = useState("");
  const [cePem, setCePem] = useState("");
  const [ceInstallationId, setCeInstallationId] = useState("");
  const [ceHostedBusy, setCeHostedBusy] = useState(false);
  const [ceHostedResult, setCeHostedResult] = useState<{ webhookUrl: string; webhookSecret: string } | null>(null);
  const [ceHostedError, setCeHostedError] = useState("");
  const [, setCeApp] = useState<GithubAppEntry | null>(null);
  const [addAppOpen, setAddAppOpen] = useState(false);
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);
  const [disconnectErr, setDisconnectErr] = useState<string | null>(null);
  const [triggerAccess, setTriggerAccess] = useState<"everyone" | "contributor" | "collaborator">("everyone");
  const [savingAccess, setSavingAccess] = useState(false);
  const [accessMsg, setAccessMsg] = useState<string | null>(null);

  // Linear local form state
  const [linSecret, setLinSecret] = useState("");
  const [linRoute, setLinRoute] = useState("");
  const [linBusy, setLinBusy] = useState(false);
  const [linErr, setLinErr] = useState("");
  const [linJustEnabled, setLinJustEnabled] = useState(false);

  // Slack local form state
  const [slackSecret, setSlackSecret] = useState("");
  const [slackRoute, setSlackRoute] = useState("");
  const [slackBusy, setSlackBusy] = useState(false);
  const [slackErr, setSlackErr] = useState("");
  const [slackJustConnected, setSlackJustConnected] = useState(false);

  const app = state.githubApp;
  const phase = app?.phase ?? "idle";
  const ready = phase === "submitting" && app?.action && app?.manifest;

  const showGithub = focus === "github" || focus === "work-queue";
  const showLinear = focus === "linear" || focus === "work-queue";
  const showSlack = focus === "slack";

  const refresh = useCallback(async () => {
    if (!canQuery) {
      setLoadErr("Source setup needs a hosted account connection.");
      return;
    }
    setLoadErr("");
    try {
      const [gh, nodeList, lin, sl, hostedStatus] = await Promise.all([
        controller.fetchGithubApp(),
        controller.listNodes(),
        fetchLinearHook(controller.local).catch(() => null),
        fetchSlackHook(controller.local).catch(() => null),
        fetchHostedProvisioning(controller.local).catch(() => null),
      ]);
      setInfo(gh);
      setNodes(nodeList);
      setLinear(lin);
      setSlack(sl);
      setHosted(hostedStatus);
      const stored = gh.apps.find((a) => a.defaultNode)?.defaultNode ?? gh.defaultNode ?? "";
      setDefaultNode(stored || "");
      const access = gh.apps.find((a) => a.triggerAccess)?.triggerAccess ?? gh.triggerAccess ?? "everyone";
      setTriggerAccess(access);
      if (lin?.defaultNode) setLinRoute(lin.defaultNode);
      if (sl?.defaultNode) setSlackRoute(sl.defaultNode);
    } catch (e) {
      setLoadErr(String((e as Error).message || e));
    }
  }, [canQuery]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (phase === "done") {
      void refresh();
      onChanged?.();
    }
  }, [phase, refresh, onChanged]);

  const apps = info?.apps ?? [];
  const mention = apps.find((a) => a.mention)?.mention || "bivy";
  const anyInstalled = apps.some((a) => a.installed);
  const anyServed = apps.some((a) => a.hosted || a.servedBy?.online);
  const hostedReady = Boolean(hosted?.execution.ready);
  const readyToRun = apps.length > 0 && anyInstalled && (hostedReady || anyServed || apps.some((a) => a.servedBy));

  async function saveDefaultNode() {
    setSavingNode(true);
    setNodeMsg(null);
    try {
      const saved = await controller.setGithubAppDefaultNode(defaultNode.trim());
      setNodeMsg("Saved");
      setInfo((cur) => (cur
        ? { ...cur, defaultNode: saved, apps: cur.apps.map((a) => ({ ...a, defaultNode: saved })) }
        : cur));
      onChanged?.();
      setTimeout(() => setNodeMsg(null), 1500);
    } catch (e) {
      setNodeMsg(String((e as Error).message || e));
    } finally {
      setSavingNode(false);
    }
  }

  async function connectExistingApp() {
    if (state.currentNodeId) {
      controller.githubAppConnectExisting({ appId: ceAppId.trim(), privateKeyPem: cePem.trim() });
      return;
    }
    setCeHostedBusy(true);
    setCeHostedError("");
    try {
      const result = await controller.connectHostedGithubApp({
        appId: ceAppId.trim(),
        privateKeyPem: cePem.trim(),
        ...(ceInstallationId.trim() ? { installationId: ceInstallationId.trim() } : {}),
      });
      setCeHostedResult({ webhookUrl: result.webhookUrl, webhookSecret: result.webhookSecret });
      setCePem("");
      await refresh();
      onChanged?.();
    } catch (error) {
      setCeHostedError(String((error as Error)?.message || error));
    } finally {
      setCeHostedBusy(false);
    }
  }

  async function saveTriggerAccess(next: "everyone" | "contributor" | "collaborator") {
    setSavingAccess(true);
    setAccessMsg(null);
    const prev = triggerAccess;
    setTriggerAccess(next);
    try {
      const saved = await controller.setGithubAppTriggerAccess(next);
      setTriggerAccess(saved);
      setInfo((cur) => (cur
        ? { ...cur, triggerAccess: saved, apps: cur.apps.map((a) => ({ ...a, triggerAccess: saved })) }
        : cur));
      setAccessMsg("Saved");
      onChanged?.();
      setTimeout(() => setAccessMsg(null), 1500);
    } catch (e) {
      setTriggerAccess(prev);
      setAccessMsg(String((e as Error).message || e));
    } finally {
      setSavingAccess(false);
    }
  }

  async function disconnectApp(entry: GithubAppEntry) {
    const id = appKey(entry);
    if (!confirm(`Disconnect ${entry.name || entry.mention || "this GitHub App"}? The key is wiped on this node; the app is not deleted on GitHub.`)) {
      return;
    }
    setDisconnectErr(null);
    setDisconnectingId(id);
    try {
      await controller.githubAppDisconnect(entry.appId, entry.hookId);
      await refresh();
      onChanged?.();
      const still = (await controller.fetchGithubApp()).apps.some((a) => appKey(a) === id);
      if (still) setDisconnectErr("Disconnect didn't take effect — try again shortly.");
    } catch (e) {
      setDisconnectErr(String((e as Error).message || e));
    } finally {
      setDisconnectingId(null);
    }
  }

  function openReconnect(entry?: GithubAppEntry) {
    setCeApp(entry ?? null);
    setCeAppId(entry?.appId ?? "");
    setCePem("");
    setShowExisting(true);
    setAddAppOpen(true);
  }

  function onPemFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setCePem(String(reader.result || "").trim());
    reader.readAsText(file);
  }

  async function createLinearEndpoint() {
    setLinBusy(true);
    setLinErr("");
    try {
      const next = await connectLinearHook(controller.local, { defaultNode: linRoute || undefined });
      setLinear(next);
      onChanged?.();
    } catch (e) {
      setLinErr(String((e as Error).message || e));
    } finally {
      setLinBusy(false);
    }
  }

  async function finishLinear() {
    setLinBusy(true);
    setLinErr("");
    try {
      const next = await connectLinearHook(controller.local, {
        signingSecret: linSecret.trim(),
        defaultNode: linRoute || undefined,
      });
      setLinear(next);
      setLinSecret("");
      setLinJustEnabled(Boolean(next.enabled));
      onChanged?.();
    } catch (e) {
      setLinErr(String((e as Error).message || e));
    } finally {
      setLinBusy(false);
    }
  }

  async function disconnectLinear() {
    if (!confirm("Disconnect Linear? Its webhook URL will stop accepting issues.")) return;
    setLinBusy(true);
    setLinErr("");
    try {
      await disconnectLinearHook(controller.local);
      setLinear(null);
      setLinJustEnabled(false);
      onChanged?.();
    } catch (e) {
      setLinErr(String((e as Error).message || e));
    } finally {
      setLinBusy(false);
    }
  }

  async function connectSlack() {
    setSlackBusy(true);
    setSlackErr("");
    try {
      const next = await connectSlackHook(controller.local, {
        signingSecret: slackSecret.trim(),
        defaultNode: slackRoute || undefined,
      });
      setSlack(next);
      setSlackSecret("");
      setSlackJustConnected(true);
      onChanged?.();
    } catch (e) {
      setSlackErr(String((e as Error).message || e));
    } finally {
      setSlackBusy(false);
    }
  }

  async function disconnectSlack() {
    if (!confirm("Disconnect Slack? The slash-command URL will stop accepting requests.")) return;
    setSlackBusy(true);
    setSlackErr("");
    try {
      await disconnectSlackHook(controller.local);
      setSlack(null);
      setSlackJustConnected(false);
      onChanged?.();
    } catch (e) {
      setSlackErr(String((e as Error).message || e));
    } finally {
      setSlackBusy(false);
    }
  }

  const primaryDoneLabel =
    focus === "slack" && slack?.enabled ? "Done — Slack is live"
      : focus === "linear" && linear?.enabled ? "Done — Linear is live"
        : focus === "github" && readyToRun ? "Done — GitHub is live"
          : readyToRun && (focus === "work-queue") ? "Done — ready to run"
            : "Done";

  return (
    <div className="wizard-scrim" onClick={onClose}>
      <div
        className="wizard autom-editor wq-setup"
        role="dialog"
        aria-modal="true"
        aria-label={titleFor(focus)}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="wizard-head">
          <div className="wq-head-text">
            <strong>{titleFor(focus)}</strong>
            <span className="wq-head-sub">Stays in Automations · nothing to find in Settings</span>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="wizard-body">
          <p className="settings-hint wq-lead">{leadFor(focus)}</p>

          {focus === "work-queue" && (
            <div className="wq-how">
              <div className="autom-field-label">How it fires</div>
              <ol className="wq-how-list">
                <li>
                  Add a <code>bivy</code> label (or <code>{'bivy/<machine>'}</code> to pin a node) on an issue —
                  or comment <code>@{mention}</code> with what to do.
                </li>
                <li>An online machine—or your configured hosted ephemeral runner—claims the item, runs your checks, and opens a PR.</li>
              </ol>
            </div>
          )}

          {loadErr && <p className="settings-error">{loadErr}</p>}

          {/* ── GitHub ──────────────────────────────────────────────── */}
          {showGithub && (
            <div className="autom-field-block">
              <div className="autom-field-label">
                <span className="wq-section-icon" aria-hidden="true"><GhMark /></span>
                GitHub
              </div>
              {apps.length === 0 ? (
                <div className="wq-status-card">
                  <p className="settings-hint">
                    No GitHub App yet. Create one (private key stays on this machine) or connect an app you already own.
                  </p>
                  <label className="field-label" htmlFor="wq-org">Organization (optional)</label>
                  <input
                    id="wq-org"
                    className="picker-search"
                    value={org}
                    placeholder="leave blank for your personal account"
                    disabled={phase === "starting" || phase === "submitting" || phase === "completing"}
                    onChange={(e) => setOrg(e.target.value)}
                  />
                  {ready ? (
                    <form method="post" action={app!.action} onSubmit={markGithubAppPending}>
                      <input type="hidden" name="manifest" value={JSON.stringify(app!.manifest)} />
                      <button className="btn primary block" type="submit">Continue to GitHub →</button>
                    </form>
                  ) : (
                    <button
                      type="button"
                      className="btn primary"
                      disabled={phase === "starting" || phase === "completing" || !canQuery}
                      onClick={() => controller.githubAppManifestStart(org.trim() || undefined)}
                    >
                      {phase === "starting" ? "Preparing…" : phase === "completing" ? "Finishing…" : "Create GitHub App"}
                    </button>
                  )}
                  {!showExisting && (
                    <button type="button" className="link-btn" onClick={() => setShowExisting(true)}>
                      Connect an existing app instead →
                    </button>
                  )}
                  {showExisting && (
                    <div className="ce-form">
                      <label className="field-label">App ID</label>
                      <input className="picker-search" value={ceAppId} placeholder="e.g. 123456" onChange={(e) => setCeAppId(e.target.value)} />
                      <label className="field-label">Private key (.pem)</label>
                      <input className="ce-file" type="file" accept=".pem,application/x-pem-file,text/plain" onChange={onPemFile} />
                      <textarea
                        className="picker-search ce-pem"
                        value={cePem}
                        rows={3}
                        placeholder="…or paste the PEM here"
                        onChange={(e) => setCePem(e.target.value)}
                      />
                      {!state.currentNodeId && (
                        <>
                          <label className="field-label">Installation ID (only needed for apps installed on multiple accounts)</label>
                          <input className="picker-search" value={ceInstallationId} placeholder="auto-selected when there is one" onChange={(e) => setCeInstallationId(e.target.value)} />
                        </>
                      )}
                      <button
                        type="button"
                        className="btn primary"
                        disabled={!ceAppId.trim() || !cePem.trim() || phase === "completing" || ceHostedBusy}
                        onClick={() => void connectExistingApp()}
                      >
                        {phase === "completing" || ceHostedBusy ? "Connecting…" : state.currentNodeId ? "Connect app to this machine" : "Connect app for ephemeral runs"}
                      </button>
                      {ceHostedError && <div className="banner error inline">{ceHostedError}</div>}
                      {ceHostedResult && (
                        <div className="autom-success" role="status">
                          <strong>Hosted App ready.</strong> Set its webhook URL to <code>{ceHostedResult.webhookUrl}</code> and secret to <code>{ceHostedResult.webhookSecret}</code>.
                        </div>
                      )}
                    </div>
                  )}
                  {phase === "completing" && <p className="settings-hint">Finishing on the node…</p>}
                  {phase === "done" && (
                    <div className="autom-success" role="status">
                      <strong>App ready.</strong> Install it on a repository so it can receive issues.{" "}
                      <a href={app?.installUrl || "https://github.com/settings/installations"} target="_blank" rel="noreferrer">
                        Install on GitHub →
                      </a>
                    </div>
                  )}
                  {phase === "error" && <div className="banner error inline">{app?.error || "GitHub App setup failed."}</div>}
                </div>
              ) : (
                <div className="wq-status-card">
                  {apps.map((entry) => (
                    <div className="wq-app-row" key={appKey(entry)}>
                      <div className="wq-app-row-main">
                        <div className="wq-app-title-row">
                          <strong>{entry.name || entry.mention || "GitHub App"}</strong>
                          <span className={`autom-status ${entry.installed === false ? "warn" : entry.hosted || entry.servedBy?.online || hostedReady ? "on" : "warn"}`}>
                            {entry.installed === false
                              ? "Needs install"
                              : entry.hosted || hostedReady
                                ? "Ephemeral ready"
                                : entry.servedBy?.online
                                ? "Live"
                                : entry.servedBy
                                  ? "Node offline"
                                  : "Needs node"}
                          </span>
                        </div>
                        {entry.owner && (
                          <span className="settings-hint">
                            {entry.ownerType === "Organization" ? "org" : "personal"} · {entry.owner}
                          </span>
                        )}
                        {entry.mention && (
                          <span className="settings-hint">Trigger with <code>@{entry.mention}</code></span>
                        )}
                        {entry.installed === false ? (
                          <p className="schedule-hint warn">
                            Not installed on any repo yet.{" "}
                            <a href={installHref(entry)} target="_blank" rel="noreferrer">Install it now →</a>
                          </p>
                        ) : (
                          <span className="settings-hint">
                            Installed on {entry.installCount ?? "some"} {(entry.installCount === 1) ? "repo" : "repos"}.{" "}
                            <a href={installHref(entry)} target="_blank" rel="noreferrer">Manage →</a>
                          </span>
                        )}
                        {entry.hosted || hostedReady ? (
                          <span className="settings-hint">Served on demand by your ephemeral runner.</span>
                        ) : entry.servedBy === null ? (
                          <p className="schedule-hint warn">
                            No online machine holds this app&apos;s key — queue items won&apos;t be claimed.{" "}
                            <button type="button" className="link-btn" onClick={() => openReconnect(entry)}>
                              Connect key on this machine →
                            </button>
                          </p>
                        ) : entry.servedBy && (
                          <span className="settings-hint">
                            Served by <strong>{entry.servedBy.name || entry.servedBy.id}</strong>
                            {entry.servedBy.online ? "" : " (offline)"}.
                          </span>
                        )}
                        <div className="row-actions" style={{ marginTop: 6 }}>
                          <button
                            type="button"
                            className="btn sm danger-ghost"
                            disabled={disconnectingId !== null}
                            onClick={() => void disconnectApp(entry)}
                          >
                            {disconnectingId === appKey(entry) ? "Disconnecting…" : "Disconnect"}
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}

                  {disconnectErr && <p className="settings-error">{disconnectErr}</p>}

                  <div className="settings-field" style={{ marginTop: 4 }}>
                    <label className="field-label" htmlFor="wq-default-node">Default machine for untagged work</label>
                    <select
                      id="wq-default-node"
                      className="picker-search"
                      value={defaultNode}
                      onChange={(e) => setDefaultNode(e.target.value)}
                    >
                      <option value="">Shared queue (any online machine)</option>
                      {nodes.map((n) => (
                        <option key={n.id} value={String(n.name || n.id)}>{String(n.name || n.id)}</option>
                      ))}
                    </select>
                    <div className="row-actions">
                      <button type="button" className="btn sm" disabled={savingNode} onClick={() => void saveDefaultNode()}>
                        {savingNode ? "Saving…" : "Save"}
                      </button>
                      {nodeMsg && <span className="settings-hint">{nodeMsg}</span>}
                    </div>
                  </div>

                  <div className="settings-field">
                    <label className="field-label" htmlFor="wq-trigger-access">Who can trigger runs</label>
                    <select
                      id="wq-trigger-access"
                      className="picker-search"
                      value={triggerAccess}
                      disabled={savingAccess}
                      onChange={(e) => void saveTriggerAccess(e.target.value as "everyone" | "contributor" | "collaborator")}
                    >
                      <option value="everyone">Everyone — any GitHub user (default)</option>
                      <option value="contributor">Contributors — prior merged contribution, or higher</option>
                      <option value="collaborator">Collaborators only — push access</option>
                    </select>
                    <p className="settings-hint">
                      Account-wide — applies to every app above. Restrict who can start runs via{" "}
                      <code>@{mention}</code> on public repos.
                    </p>
                    {accessMsg && <span className="settings-hint">{accessMsg}</span>}
                  </div>

                  {!addAppOpen ? (
                    <button type="button" className="btn sm" onClick={() => { setAddAppOpen(true); setShowExisting(false); setCeApp(null); }}>
                      + Add another GitHub App
                    </button>
                  ) : (
                    <div className="wq-status-card" style={{ marginTop: 4 }}>
                      <div className="autom-field-label">Add another app</div>
                      <p className="settings-hint">One app per personal account or organization you want Bivy to cover.</p>
                      <label className="field-label" htmlFor="wq-org-2">Organization (optional)</label>
                      <input
                        id="wq-org-2"
                        className="picker-search"
                        value={org}
                        placeholder="leave blank for your personal account"
                        disabled={phase === "starting" || phase === "submitting" || phase === "completing"}
                        onChange={(e) => setOrg(e.target.value)}
                      />
                      {ready ? (
                        <form method="post" action={app!.action} onSubmit={markGithubAppPending}>
                          <input type="hidden" name="manifest" value={JSON.stringify(app!.manifest)} />
                          <button className="btn primary block" type="submit">Continue to GitHub →</button>
                        </form>
                      ) : (
                        <button
                          type="button"
                          className="btn primary"
                          disabled={phase === "starting" || phase === "completing" || !canQuery}
                          onClick={() => controller.githubAppManifestStart(org.trim() || undefined)}
                        >
                          {phase === "starting" ? "Preparing…" : phase === "completing" ? "Finishing…" : "Create GitHub App"}
                        </button>
                      )}
                      <button type="button" className="link-btn" onClick={() => openReconnect()}>
                        Connect an existing app instead →
                      </button>
                      {showExisting && (
                        <div className="ce-form">
                          <label className="field-label">App ID</label>
                          <input className="picker-search" value={ceAppId} placeholder="e.g. 123456" onChange={(e) => setCeAppId(e.target.value)} />
                          <label className="field-label">Private key (.pem)</label>
                          <input className="ce-file" type="file" accept=".pem,application/x-pem-file,text/plain" onChange={onPemFile} />
                          <textarea
                            className="picker-search ce-pem"
                            value={cePem}
                            rows={3}
                            placeholder="…or paste the PEM here"
                            onChange={(e) => setCePem(e.target.value)}
                          />
                          {!state.currentNodeId && (
                            <>
                              <label className="field-label">Installation ID (only needed for apps installed on multiple accounts)</label>
                              <input className="picker-search" value={ceInstallationId} placeholder="auto-selected when there is one" onChange={(e) => setCeInstallationId(e.target.value)} />
                            </>
                          )}
                          <button
                            type="button"
                            className="btn primary"
                            disabled={!ceAppId.trim() || !cePem.trim() || phase === "completing" || ceHostedBusy}
                            onClick={() => void connectExistingApp()}
                          >
                            {phase === "completing" || ceHostedBusy ? "Connecting…" : state.currentNodeId ? "Connect app to this machine" : "Connect app for ephemeral runs"}
                          </button>
                          {ceHostedError && <div className="banner error inline">{ceHostedError}</div>}
                          {ceHostedResult && (
                            <div className="autom-success" role="status">
                              <strong>Hosted App ready.</strong> Set its webhook URL to <code>{ceHostedResult.webhookUrl}</code> and secret to <code>{ceHostedResult.webhookSecret}</code>.
                            </div>
                          )}
                        </div>
                      )}
                      <button type="button" className="link-btn" onClick={() => setAddAppOpen(false)}>Cancel</button>
                    </div>
                  )}

                  {readyToRun && (
                    <div className="autom-success" role="status">
                      <strong>Ready.</strong> Label an issue <code>bivy</code> or comment{" "}
                      <code>@{mention}</code> with what to do.
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ── Linear ──────────────────────────────────────────────── */}
          {showLinear && (
            <div className="autom-field-block">
              <div className="autom-field-label">
                <span className="wq-section-icon" aria-hidden="true"><LinMark /></span>
                Linear{focus === "work-queue" ? " (optional)" : ""}
              </div>
              <div className="wq-status-card">
                {linErr && <p className="settings-error">{linErr}</p>}
                {linJustEnabled && linear?.enabled && (
                  <div className="autom-success" role="status">
                    <strong>Linear is live.</strong> Label an issue <code>bivy</code> (or <code>{'bivy/<machine>'}</code>) to enqueue it.
                  </div>
                )}
                {!linear ? (
                  <>
                    <p className="settings-hint">
                      Create a Bivy webhook URL, paste it into Linear, then bring Linear&apos;s signing secret back here.
                    </p>
                    <label className="field-label" htmlFor="lin-route">Default machine (optional)</label>
                    <select
                      id="lin-route"
                      className="picker-search"
                      value={linRoute}
                      disabled={linBusy}
                      onChange={(e) => setLinRoute(e.target.value)}
                    >
                      <option value="">Shared queue</option>
                      {nodes.map((n) => (
                        <option key={n.id} value={String(n.name || n.id)}>{String(n.name || n.id)}</option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="btn primary"
                      disabled={linBusy || !canQuery}
                      onClick={() => void createLinearEndpoint()}
                    >
                      {linBusy ? "Creating…" : "Create webhook URL"}
                    </button>
                  </>
                ) : (
                  <>
                    <div className="wq-app-title-row">
                      <strong>{linear.enabled ? "Connected" : "Finish connecting"}</strong>
                      <span className={`autom-status ${linear.enabled ? "on" : "warn"}`}>
                        {linear.enabled ? "Live" : "Needs secret"}
                      </span>
                    </div>
                    <p className="settings-hint">
                      In <strong>Linear → Settings → API → Webhooks</strong>, create an <strong>Issue</strong> webhook with this URL:
                    </p>
                    <div className="reveal-row">
                      <code className="reveal-value">{linear.endpoint}</code>
                      <button
                        type="button"
                        className="btn sm"
                        onClick={() => void navigator.clipboard?.writeText(linear.endpoint)}
                      >
                        Copy
                      </button>
                    </div>
                    <ol className="wq-how-list" style={{ paddingLeft: 18 }}>
                      <li>Copy the signing secret Linear generates.</li>
                      <li>Paste it below{linear.enabled ? " to rotate" : " to finish"}.</li>
                      <li>Create labels <code>bivy</code> and optionally <code>bivy/node-name</code>.</li>
                    </ol>
                    <label className="field-label" htmlFor="lin-secret">
                      {linear.enabled ? "Replace signing secret" : "Linear signing secret"}
                    </label>
                    <input
                      id="lin-secret"
                      className="picker-search"
                      type="password"
                      autoComplete="off"
                      value={linSecret}
                      disabled={linBusy}
                      placeholder="Signing secret from Linear"
                      onChange={(e) => setLinSecret(e.target.value)}
                    />
                    <label className="field-label" htmlFor="lin-route-2">Default machine (optional)</label>
                    <select
                      id="lin-route-2"
                      className="picker-search"
                      value={linRoute}
                      disabled={linBusy}
                      onChange={(e) => setLinRoute(e.target.value)}
                    >
                      <option value="">Shared queue</option>
                      {nodes.map((n) => (
                        <option key={n.id} value={String(n.name || n.id)}>{String(n.name || n.id)}</option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="btn primary"
                      disabled={linBusy || linSecret.trim().length < 16}
                      onClick={() => void finishLinear()}
                    >
                      {linBusy ? "Saving…" : linear.enabled ? "Update connection" : "Connect Linear"}
                    </button>
                    <p className="settings-hint">
                      Each runner also needs <code>BIVY_LINEAR_API_KEY</code> and a default <code>BIVY_LINEAR_REPO=owner/repo</code>.
                    </p>
                    <button
                      type="button"
                      className="btn sm danger-ghost"
                      disabled={linBusy}
                      onClick={() => void disconnectLinear()}
                    >
                      Disconnect Linear
                    </button>
                  </>
                )}
              </div>
            </div>
          )}

          {/* ── Slack ───────────────────────────────────────────────── */}
          {showSlack && (
            <div className="autom-field-block">
              <div className="autom-field-label">
                <span className="wq-section-icon" aria-hidden="true"><SlackMark /></span>
                Slack
              </div>
              <div className="wq-status-card">
                {slackErr && <p className="settings-error">{slackErr}</p>}
                {slackJustConnected && slack?.enabled && (
                  <div className="autom-success" role="status">
                    <strong>Slack is live.</strong> Paste the Request URL into your slash command, then try{" "}
                    <code>/bivy fix the failing tests</code>.
                  </div>
                )}
                {slack?.enabled ? (
                  <>
                    <div className="wq-app-title-row">
                      <strong>Connected</strong>
                      <span className="autom-status on">Live</span>
                    </div>
                    <p className="settings-hint">Use this as your Slack app&apos;s slash-command Request URL:</p>
                    <div className="reveal-row">
                      <code className="reveal-value">{slack.endpoint}</code>
                      <button
                        type="button"
                        className="btn sm"
                        onClick={() => void navigator.clipboard?.writeText(slack.endpoint)}
                      >
                        Copy
                      </button>
                    </div>
                    <div className="autom-field-label" style={{ marginTop: 4 }}>Commands</div>
                    <code className="wq-cmd">/bivy fix the failing tests</code>
                    <code className="wq-cmd">/bivy on macbook fix the failing tests</code>
                    <code className="wq-cmd">/bivy in owner/repo fix the failing tests</code>
                    <p className="settings-hint">
                      Add <code>in owner/repo</code> for an isolated checkout + PR. Add <code>on node</code> to pick a machine.
                    </p>
                    <button
                      type="button"
                      className="btn sm danger-ghost"
                      disabled={slackBusy}
                      onClick={() => void disconnectSlack()}
                    >
                      Disconnect Slack
                    </button>
                  </>
                ) : (
                  <>
                    <ol className="wq-how-list" style={{ paddingLeft: 18 }}>
                      <li>Create a Slack app, then open <strong>Basic Information</strong>.</li>
                      <li>Copy its <strong>Signing Secret</strong> below.</li>
                      <li>After connecting, create a slash command named <code>/bivy</code> and paste the Request URL shown here.</li>
                    </ol>
                    <label className="field-label" htmlFor="slack-secret">Slack signing secret</label>
                    <input
                      id="slack-secret"
                      className="picker-search"
                      type="password"
                      autoComplete="off"
                      value={slackSecret}
                      disabled={slackBusy}
                      placeholder="Signing Secret"
                      onChange={(e) => setSlackSecret(e.target.value)}
                    />
                    <label className="field-label" htmlFor="slack-route">Default machine (optional)</label>
                    <select
                      id="slack-route"
                      className="picker-search"
                      value={slackRoute}
                      disabled={slackBusy}
                      onChange={(e) => setSlackRoute(e.target.value)}
                    >
                      <option value="">Shared queue</option>
                      {nodes.map((n) => (
                        <option key={n.id} value={String(n.name || n.id)}>{String(n.name || n.id)}</option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="btn primary"
                      disabled={slackBusy || slackSecret.trim().length < 16 || !canQuery}
                      onClick={() => void connectSlack()}
                    >
                      {slackBusy ? "Connecting…" : "Connect Slack"}
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="wizard-actions">
          <span className="settings-hint">Connections are managed only here</span>
          <button type="button" className="btn primary autom-save-btn" onClick={onClose}>
            {primaryDoneLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function GhMark() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
function LinMark() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
      <path d="M2.86 16.14a3.43 3.43 0 0 0 4.85 4.85L21.14 7.56A3.43 3.43 0 0 0 16.29 2.7L2.86 16.14Z" opacity=".35" />
      <path d="M3.43 12a.86.86 0 0 0-.86.86v4.28A5.14 5.14 0 0 0 7.71 22.3h4.29a.86.86 0 0 0 0-1.72H7.71A3.43 3.43 0 0 1 4.29 17.14v-4.28A.86.86 0 0 0 3.43 12Zm8.57-9.43a.86.86 0 0 0 0 1.72h4.29a3.43 3.43 0 0 1 3.42 3.42v4.29a.86.86 0 0 0 1.72 0V7.71A5.14 5.14 0 0 0 16.29 2.57H12Z" />
    </svg>
  );
}
function SlackMark() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
      <path d="M6 15a2 2 0 1 1-2-2h2v2Zm1 0a2 2 0 1 1 4 0v5a2 2 0 1 1-4 0v-5Zm2-8a2 2 0 1 1 2-2v2H9Zm0 1a2 2 0 1 1 0 4H4a2 2 0 1 1 0-4h5Zm8 2a2 2 0 1 1 2 2h-2V10Zm-1 0a2 2 0 1 1-4 0V5a2 2 0 1 1 4 0v5Zm-2 8a2 2 0 1 1-2 2v-2h2Zm0-1a2 2 0 1 1 0-4h5a2 2 0 1 1 0 4h-5Z" />
    </svg>
  );
}
