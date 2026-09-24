// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { AppView, OpenAppViewResult, SessionApp, SessionAppsResult } from "@bivy/core";
import { controller, useAppState } from "../store/useStore.js";
import { Sheet } from "./Sheet.js";
import { ConfirmDialog } from "./AppDialog.js";
import { accountOrigin } from "../packaged-client.js";
const TerminalOverlay = lazy(() => import("./Terminal.js").then((module) => ({ default: module.TerminalOverlay })));

export function AppsSheet({ sessionId, appId, onClose }: { sessionId: string; appId?: string; onClose: () => void }) {
  const { connection } = useAppState();
  const [result, setResult] = useState<SessionAppsResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [terminal, setTerminal] = useState<string | null>(null);
  const [link, setLink] = useState<{ viewId: string; url: string } | null>(null);
  const [confirm, setConfirm] = useState<{ app: SessionApp; view?: AppView } | null>(null);
  const generation = useRef(0);
  const online = connection.status === "online";

  // A network blip must not unmount the PTY renderer: it owns reconnect and
  // scrollback replay. Only changing the session/machine leaves that view.
  useEffect(() => { setTerminal(null); }, [sessionId, connection.currentNodeId]);

  useEffect(() => {
    const current = ++generation.current;
    setBusy(true); setError(""); setResult(null); setLink(null); setConfirm(null);
    void controller.appCommand("apps.list", sessionId).then((event) => {
      if (generation.current === current) setResult(event as unknown as SessionAppsResult);
    }).catch((e: unknown) => {
      if (generation.current === current) setError(e instanceof Error ? e.message : "Could not load apps.");
    }).finally(() => { if (generation.current === current) setBusy(false); });
    return () => { generation.current = current + 1; };
  }, [sessionId, connection.currentNodeId, online, refresh]);

  // One-use links expire after a minute; remove stale links rather than invite
  // a failed launch. Opening in a top-level tab works with mobile cookie policy.
  useEffect(() => {
    if (!link) return;
    const timer = setTimeout(() => setLink(null), 55_000);
    return () => clearTimeout(timer);
  }, [link]);

  const open = async (app: SessionApp, view: AppView) => {
    const current = generation.current;
    setBusy(true); setError(""); setLink(null); setConfirm(null);
    // Create the window during the tap, before awaiting the node, so mobile
    // browsers don't classify it as an unsolicited popup. No opener is exposed.
    const popup = view.kind === "web" ? window.open("about:blank", "_blank") : null;
    try {
      if (popup) {
        popup.opener = null;
        popup.document.title = "Bivy · Opening app";
        const status = popup.document.createElement("p");
        status.setAttribute("role", "status");
        status.textContent = "Opening app…";
        popup.document.body?.append(status);
      }
      const response = await controller.appCommand("apps.open", sessionId, { appId: app.id, viewId: view.id, returnTo: `${accountOrigin()}/sessions/${encodeURIComponent(sessionId)}` }) as unknown as OpenAppViewResult;
      if (generation.current !== current) { popup?.close(); return; }
      if (response.kind === "terminal") setTerminal(response.termId);
      else if (response.kind === "web") {
        const url = new URL(response.url);
        if (url.protocol !== "https:" || url.origin === location.origin || url.username || url.password) throw new Error("Machine returned an unsafe preview URL.");
        if (popup && !popup.closed) { popup.location.replace(url.href); onClose(); }
        else setLink({ viewId: view.id, url: url.href });
      } else throw new Error("This app view is not supported by this client.");
    } catch (e) { popup?.close(); if (generation.current === current) setError(e instanceof Error ? e.message : "Could not open view."); }
    finally { if (generation.current === current) setBusy(false); }
  };
  const remove = async (app: SessionApp) => {
    const current = generation.current;
    setBusy(true); setError(""); setConfirm(null);
    try {
      await controller.appCommand("apps.remove", sessionId, { appId: app.id });
      if (generation.current === current) setRefresh((n) => n + 1);
    } catch (e) { if (generation.current === current) setError(e instanceof Error ? e.message : "Could not remove app."); }
    finally { if (generation.current === current) setBusy(false); }
  };

  if (terminal) return <Suspense fallback={<Sheet title="App terminal" onClose={() => setTerminal(null)}><p role="status">Loading terminal…</p></Sheet>}>
    <TerminalOverlay sessionId={sessionId} attachTermId={terminal} attachOnly onClose={() => setTerminal(null)} />
  </Suspense>;
  return <Sheet title="Apps" ariaLabel="Session apps" onClose={onClose} autoFocusSearch={false} size="large"
    headExtra={<button className="btn sm ghost" onClick={() => setRefresh((n) => n + 1)} disabled={busy || !online}>Refresh</button>}>
    <p className="muted">Web views open in a preview tab with a Back to chat header. Terminal views run here.</p>
    {busy && <p role="status">{result ? "Preparing…" : "Loading apps…"}</p>}
    {error && <p role="alert" className="artifact-unavailable">{error}</p>}
    {result && !result.previewAvailable && <p className="muted">Web previews need a dedicated HTTPS preview domain configured on this machine. Terminal views work without it.</p>}
    {result?.apps.length === 0 && <div className="changes-binary">No apps published yet. Ask the agent to create a manifest and run <code>bivy app publish bivy.app.json</code>.</div>}
    {result && appId && !result.apps.some((app) => app.id === appId) && <p role="status">This app is no longer available. Ask the agent to republish it; previews expire when the machine restarts.</p>}
    {result?.apps.filter((app) => !appId || app.id === appId).map((app) => <section className="artifacts-group" key={app.id} aria-label={app.name}>
      <div className="app-views-heading"><strong className="artifact-name">{app.name}</strong>
        <button className="btn sm ghost" disabled={busy || !online} onClick={() => setConfirm({ app })} aria-label={`Remove ${app.name}`}>Remove</button>
      </div>
      {app.views.map((view) => <div className="artifact-row app-view-row" key={view.id}>
        <div className="artifact-main">
          <strong className="artifact-name">{view.name}</strong>
          <span className="artifact-meta">{view.kind === "terminal" ? "Interactive terminal · starts on request" : view.source === "static" ? "Web · published snapshot" : "Web · live server"}</span>
          {view.kind === "terminal" && <code className="app-view-command">{[view.command, ...view.args.map((arg) => JSON.stringify(arg))].join(" ")}</code>}
        </div>
        {link?.viewId === view.id
          ? <a className="btn sm" href={link.url} target="_blank" rel="noopener noreferrer" onClick={() => setTimeout(onClose, 0)}>Open preview ↗</a>
          : <button className="btn sm" disabled={busy || !online || (view.kind === "web" && !result.previewAvailable)} onClick={() => view.kind === "terminal" ? setConfirm({ app, view }) : void open(app, view)}>
            {view.kind === "terminal" ? "Open terminal" : "Open preview"}
          </button>}
      </div>)}
    </section>)}
    <p className="muted">Apps are available while this machine is running. Removing an app closes its terminals and revokes preview access; externally started web servers keep running.</p>
    {confirm && <ConfirmDialog
      title={confirm.view ? `Open ${confirm.view.name}?` : `Remove ${confirm.app.name}?`}
      message={confirm.view?.kind === "terminal"
        ? `This starts or reconnects to ${JSON.stringify([confirm.view.command, ...confirm.view.args])}. It runs with the machine user’s permissions, not in a new sandbox. Only run code you trust.`
        : "Preview access will be revoked and this app’s terminals stopped. Project files and externally started servers are not removed."}
      confirmLabel={confirm.view ? "Open terminal" : "Remove app"} danger={!confirm.view}
      onCancel={() => setConfirm(null)} onConfirm={() => { if (confirm.view) void open(confirm.app, confirm.view); else void remove(confirm.app); }}
    />}
  </Sheet>;
}
