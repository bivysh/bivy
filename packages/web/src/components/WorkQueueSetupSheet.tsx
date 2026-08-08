// SPDX-License-Identifier: AGPL-3.0-only
//
// In-Automations setup for the "Work issues into PRs" job. Keeps the user on
// the Automations surface instead of bouncing to Settings → Work Queue / GitHub:
// status of connected apps, create/connect, install, default node, and the
// two-line "how to fire it" recipe. Full disconnect / multi-app management
// still lives in Settings → GitHub.
import { useCallback, useEffect, useState, type ChangeEvent } from "react";
import {
  type AccountNode,
  type AppState,
  type GithubAppEntry,
  type GithubAppInfo,
  type LinearHook,
  fetchLinearHook,
} from "@bivy/core";
import { controller } from "../store/controller.js";

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

export function WorkQueueSetupSheet({
  state,
  onClose,
  onOpenFullSettings,
}: {
  state: AppState;
  onClose: () => void;
  /** Escape hatch into Settings for multi-app / disconnect / Linear webhook. */
  onOpenFullSettings: (view?: "github" | "linear") => void;
}) {
  const canQuery = !controller.direct;
  const [info, setInfo] = useState<GithubAppInfo | null>(null);
  const [nodes, setNodes] = useState<AccountNode[]>([]);
  const [linear, setLinear] = useState<LinearHook | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const [org, setOrg] = useState("");
  const [defaultNode, setDefaultNode] = useState("");
  const [savingNode, setSavingNode] = useState(false);
  const [nodeMsg, setNodeMsg] = useState<string | null>(null);
  const [showExisting, setShowExisting] = useState(false);
  const [ceAppId, setCeAppId] = useState("");
  const [cePem, setCePem] = useState("");

  const app = state.githubApp;
  const phase = app?.phase ?? "idle";
  const ready = phase === "submitting" && app?.action && app?.manifest;

  const refresh = useCallback(async () => {
    if (!canQuery) {
      setLoadErr("Work Queue setup needs a hosted account connection.");
      return;
    }
    setLoadErr("");
    try {
      const [gh, nodeList, lin] = await Promise.all([
        controller.fetchGithubApp(),
        controller.listNodes(),
        fetchLinearHook(controller.local).catch(() => null),
      ]);
      setInfo(gh);
      setNodes(nodeList);
      setLinear(lin);
      const stored = gh.apps.find((a) => a.defaultNode)?.defaultNode ?? gh.defaultNode ?? "";
      setDefaultNode(stored || "");
    } catch (e) {
      setLoadErr(String((e as Error).message || e));
    }
  }, [canQuery]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (phase === "done") void refresh();
  }, [phase, refresh]);

  const apps = info?.apps ?? [];
  const mention = apps.find((a) => a.mention)?.mention || "bivy";
  const anyInstalled = apps.some((a) => a.installed);
  const anyServed = apps.some((a) => a.servedBy?.online);
  const readyToRun = apps.length > 0 && anyInstalled && (anyServed || apps.some((a) => a.servedBy));

  async function saveDefaultNode() {
    setSavingNode(true);
    setNodeMsg(null);
    try {
      const saved = await controller.setGithubAppDefaultNode(defaultNode.trim());
      setNodeMsg("Saved");
      setInfo((cur) => (cur
        ? { ...cur, defaultNode: saved, apps: cur.apps.map((a) => ({ ...a, defaultNode: saved })) }
        : cur));
      setTimeout(() => setNodeMsg(null), 1500);
    } catch (e) {
      setNodeMsg(String((e as Error).message || e));
    } finally {
      setSavingNode(false);
    }
  }

  function onPemFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setCePem(String(reader.result || "").trim());
    reader.readAsText(file);
  }

  return (
    <div className="wizard-scrim" onClick={onClose}>
      <div
        className="wizard autom-editor wq-setup"
        role="dialog"
        aria-modal="true"
        aria-label="Work issues into PRs"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="wizard-head">
          <strong>Work issues into PRs</strong>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="wizard-body">
          <p className="settings-hint">
            Label a GitHub or Linear issue and a machine you own opens the pull request.
            No schedule and no custom webhook — the work queue is the trigger.
          </p>

          <div className="wq-how">
            <div className="autom-field-label">How it fires</div>
            <ol className="wq-how-list">
              <li>
                Add a <code>bivy</code> label (or <code>bivy/&lt;machine&gt;</code> to pin a node) on an issue —
                or comment <code>@{mention}</code> with what to do.
              </li>
              <li>An online machine that holds the app key claims the item, runs your checks, and opens a PR.</li>
            </ol>
          </div>

          {loadErr && <p className="settings-error">{loadErr}</p>}

          {/* ── GitHub status ─────────────────────────────────────────── */}
          <div className="autom-field-block">
            <div className="autom-field-label">GitHub</div>
            {apps.length === 0 ? (
              <div className="wq-status-card">
                <p className="settings-hint">No GitHub App connected yet. Create one (key stays on this machine) or connect an app you already own.</p>
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
                    <button
                      type="button"
                      className="btn primary"
                      disabled={!ceAppId.trim() || !cePem.trim() || phase === "completing"}
                      onClick={() => controller.githubAppConnectExisting({ appId: ceAppId.trim(), privateKeyPem: cePem.trim() })}
                    >
                      {phase === "completing" ? "Connecting…" : "Connect app to this machine"}
                    </button>
                  </div>
                )}
                {phase === "completing" && <p className="settings-hint">Finishing on the node…</p>}
                {phase === "done" && (
                  <div className="banner info inline">
                    ✓ App ready. Install it on a repository so it can receive issues.{" "}
                    <a href={app?.installUrl || "https://github.com/settings/installations"} target="_blank" rel="noreferrer">
                      Install →
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
                      <strong>{entry.name || entry.mention || "GitHub App"}</strong>
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
                      {entry.servedBy === null ? (
                        <p className="schedule-hint warn">
                          No online machine holds this app&apos;s key — queue items won&apos;t be claimed.
                          Connect the key on a machine in{" "}
                          <button type="button" className="link-btn" onClick={() => onOpenFullSettings("github")}>Settings → GitHub</button>.
                        </p>
                      ) : entry.servedBy && (
                        <span className="settings-hint">
                          Served by <strong>{entry.servedBy.name || entry.servedBy.id}</strong>
                          {entry.servedBy.online ? "" : " (offline)"}.
                        </span>
                      )}
                    </div>
                  </div>
                ))}

                <div className="settings-field" style={{ marginTop: 10 }}>
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

                {readyToRun && (
                  <div className="banner info inline">
                    ✓ Ready. Label an issue <code>bivy</code> or comment{" "}
                    <code>@{mention}</code> with what to do.
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ── Linear (thin) ─────────────────────────────────────────── */}
          <div className="autom-field-block">
            <div className="autom-field-label">Linear (optional)</div>
            <div className="wq-status-card">
              {linear?.enabled ? (
                <p className="settings-hint">
                  ✓ Linear webhook connected. Label an issue <code>bivy</code> (or <code>bivy/&lt;machine&gt;</code>) to enqueue it.
                </p>
              ) : (
                <p className="settings-hint">
                  Not connected. Set up the Linear webhook under{" "}
                  <button type="button" className="link-btn" onClick={() => onOpenFullSettings("linear")}>Settings → Linear</button>
                  {" "}if you want the same flow from Linear issues.
                </p>
              )}
            </div>
          </div>
        </div>

        <div className="wizard-actions">
          <button type="button" className="btn" onClick={() => onOpenFullSettings("github")}>Open full settings</button>
          <button type="button" className="btn primary autom-save-btn" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
