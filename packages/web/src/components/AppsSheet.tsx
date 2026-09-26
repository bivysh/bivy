// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { AppOffer, AppView, OpenAppViewResult, SessionApp, SessionAppOffersResult, SessionAppsResult, ShareAppViewResult } from "@bivy/core";
import { controller, useAppState } from "../store/useStore.js";
import { Sheet } from "./Sheet.js";
import { ConfirmDialog } from "./AppDialog.js";
import { accountOrigin } from "../packaged-client.js";
import { writeClipboard } from "../clipboard.js";
import { PreviewPeek, peekBlocked } from "./PreviewPeek.js";
import { seedSessionDraft } from "../shareTarget.js";
const TerminalOverlay = lazy(() => import("./Terminal.js").then((module) => ({ default: module.TerminalOverlay })));
/** What each kind of view is, in the list. */
const VIEW_LABELS = {
  terminal: "Interactive terminal · starts on request",
  static: "Web · published snapshot",
  service: "Web · live server",
  managed: "Web · server run by Bivy",
  display: "Desktop app · on its own display",
} as const;

/** `nodeId` opens a session's apps on another machine without switching to it.
 *  Terminal views stream over the connected machine's link, so for another
 *  machine they hand off to the chat (`onOpenInChat`), which switches there. */
export function AppsSheet({ sessionId, appId, nodeId, onOpenInChat, onClose }: { sessionId: string; appId?: string; nodeId?: string | null; onOpenInChat?: () => void; onClose: () => void }) {
  const { connection } = useAppState();
  const remote = Boolean(nodeId) && !controller.direct && nodeId !== connection.currentNodeId;
  const machine = remote ? nodeId : connection.currentNodeId;
  const [result, setResult] = useState<SessionAppsResult | null>(null);
  // Servers running in the workspace that aren't previewed yet. Older nodes
  // don't detect them; that is an empty list, not an error.
  const [offers, setOffers] = useState<AppOffer[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [terminal, setTerminal] = useState<string | null>(null);
  const [peek, setPeek] = useState<{ url: string; app: SessionApp; view: AppView } | null>(null);
  const [link, setLink] = useState<{ viewId: string; url: string } | null>(null);
  // Per-view outcome of Copy link / Revoke access. `url` is set only when the
  // clipboard refused, so the link can be copied by hand.
  const [notice, setNotice] = useState<{ viewId: string; text: string; url?: string } | null>(null);
  const [confirm, setConfirm] = useState<{ app: SessionApp; view?: AppView } | null>(null);
  const generation = useRef(0);
  // Another machine's reachability shows up as a request error instead.
  const online = remote || connection.status === "online";

  // A network blip must not unmount the PTY renderer: it owns reconnect and
  // scrollback replay. Only changing the session/machine leaves that view.
  useEffect(() => { setTerminal(null); }, [sessionId, connection.currentNodeId]);

  useEffect(() => {
    const current = ++generation.current;
    setBusy(true); setError(""); setResult(null); setLink(null); setNotice(null); setConfirm(null);
    const offered = controller.appCommand("apps.offers", sessionId, {}, nodeId).then((event) => (event as unknown as SessionAppOffersResult).offers ?? [], () => []);
    void Promise.all([controller.appCommand("apps.list", sessionId, {}, nodeId), offered]).then(([event, found]) => {
      if (generation.current !== current) return;
      setResult(event as unknown as SessionAppsResult);
      setOffers(found);
    }).catch((e: unknown) => {
      if (generation.current === current) setError(e instanceof Error ? e.message : "Could not load apps.");
    }).finally(() => { if (generation.current === current) setBusy(false); });
    return () => { generation.current = current + 1; };
  }, [sessionId, machine, online, refresh, nodeId]);

  // One-use links expire after a minute; remove stale links rather than invite
  // a failed launch. Opening in a top-level tab works with mobile cookie policy.
  useEffect(() => {
    if (!link) return;
    const timer = setTimeout(() => setLink(null), 55_000);
    return () => clearTimeout(timer);
  }, [link]);

  /** Opens a published view, or publishes a detected server first (`offer`).
   *  Web views peek in a drawer over the chat unless a tab is asked for or this
   *  browser refuses framed preview cookies. */
  const open = async (target: { app: SessionApp; view: AppView } | { offer: AppOffer }, mode: "peek" | "tab" = "peek") => {
    const current = generation.current;
    setBusy(true); setError(""); setLink(null); setConfirm(null);
    const web = "offer" in target || target.view.kind === "web";
    const inTab = web && (mode === "tab" || peekBlocked());
    // Create the window during the tap, before awaiting the node, so mobile
    // browsers don't classify it as an unsolicited popup. No opener is exposed.
    const popup = inTab ? window.open("about:blank", "_blank") : null;
    try {
      if (popup) {
        popup.opener = null;
        popup.document.title = "Bivy · Opening app";
        const status = popup.document.createElement("p");
        status.setAttribute("role", "status");
        status.textContent = "Opening app…";
        popup.document.body?.append(status);
      }
      let app: SessionApp, view: AppView;
      if ("offer" in target) {
        app = (await controller.appCommand("apps.adopt", sessionId, { port: target.offer.port }, nodeId) as unknown as { app: SessionApp }).app;
        view = app.views[0]!;
        // Show it as published without a reload, which would cancel this open.
        if (generation.current === current) {
          const adopted = app;
          setResult((prev) => prev && { ...prev, apps: [...prev.apps, adopted] });
          setOffers((prev) => prev.filter((item) => item.port !== target.offer.port));
        }
      } else ({ app, view } = target);
      const response = await controller.appCommand("apps.open", sessionId, { appId: app.id, viewId: view.id, returnTo: `${accountOrigin()}/sessions/${encodeURIComponent(sessionId)}` }, nodeId) as unknown as OpenAppViewResult;
      if (generation.current !== current) { popup?.close(); return; }
      if (response.kind === "terminal") setTerminal(response.termId);
      else if (response.kind === "web") {
        const url = previewUrl(response.url);
        if (!inTab) { setPeek({ url, app, view }); }
        else if (popup && !popup.closed) { popup.location.replace(url); onClose(); }
        else setLink({ viewId: view.id, url });
      } else throw new Error("This app view is not supported by this client.");
    } catch (e) { popup?.close(); if (generation.current === current) setError(e instanceof Error ? e.message : "Could not open view."); }
    finally { if (generation.current === current) setBusy(false); }
  };
  const previewUrl = (raw: string) => {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.origin === location.origin || url.username || url.password) throw new Error("Machine returned an unsafe preview URL.");
    return url.href;
  };
  /** A managed server's output opens in the existing terminal overlay. */
  const logs = async (app: SessionApp, view: AppView) => {
    const current = generation.current;
    setBusy(true); setError("");
    try {
      const response = await controller.appCommand("apps.logs", sessionId, { appId: app.id, viewId: view.id }, nodeId) as unknown as OpenAppViewResult;
      if (generation.current === current && response.kind === "terminal") setTerminal(response.termId);
    } catch (e) { if (generation.current === current) setError(e instanceof Error ? e.message : "Could not open the server logs."); }
    finally { if (generation.current === current) setBusy(false); }
  };
  const share = async (app: SessionApp, view: AppView) => {
    const current = generation.current;
    setBusy(true); setError(""); setNotice(null);
    try {
      const response = await controller.appCommand("apps.share", sessionId, { appId: app.id, viewId: view.id }, nodeId) as unknown as ShareAppViewResult;
      if (generation.current !== current) return;
      const url = previewUrl(response.url);
      const hours = Math.round((response.expiresAt - Date.now()) / 3_600_000);
      const validity = `Anyone with it can open ${view.name} in any browser for ${hours} hours, or until you revoke access.`;
      setNotice(await writeClipboard(url) ? { viewId: view.id, text: `Link copied. ${validity}` } : { viewId: view.id, text: `Copy this link. ${validity}`, url });
    } catch (e) { if (generation.current === current) setError(e instanceof Error ? e.message : "Could not create a link."); }
    finally { if (generation.current === current) setBusy(false); }
  };
  /** Reviewer notes are untrusted text: they only ever become a draft. */
  const notesToMessage = (view: AppView & { kind: "web" }) => {
    const text = `Notes from people reviewing "${view.name}":\n` + (view.notes ?? []).map((n) =>
      `- "${n.note}" on ${n.selector}${n.text ? ` ("${n.text}")` : ""}, page ${n.path}, viewport ${n.viewport.width}×${n.viewport.height}`).join("\n");
    if (!controller.prefillComposer(text)) seedSessionDraft(localStorage, sessionId, text);
    onClose();
  };
  const clearNotes = async (app: SessionApp, view: AppView) => {
    const current = generation.current;
    setBusy(true); setError("");
    try { await controller.appCommand("apps.clearNotes", sessionId, { appId: app.id, viewId: view.id }, nodeId); if (generation.current === current) setRefresh((n) => n + 1); }
    catch (e) { if (generation.current === current) setError(e instanceof Error ? e.message : "Could not clear notes."); }
    finally { if (generation.current === current) setBusy(false); }
  };
  /** The stable address grants nothing by itself, so it can go on a home screen. */
  const copyAddress = async (view: AppView & { kind: "web" }) => {
    if (!view.address) return;
    const text = "Add it to your home screen: it always opens the latest version, on devices signed in to your Bivy account.";
    setNotice(await writeClipboard(view.address) ? { viewId: view.id, text: `Address copied. ${text}` } : { viewId: view.id, text: `Copy this address. ${text}`, url: view.address });
  };
  const revoke = async (app: SessionApp, view: AppView) => {
    const current = generation.current;
    setBusy(true); setError(""); setNotice(null); setLink(null);
    try {
      await controller.appCommand("apps.revoke", sessionId, { appId: app.id, viewId: view.id }, nodeId);
      if (generation.current === current) setNotice({ viewId: view.id, text: `Access revoked. Copied links and open previews of ${view.name} stopped working.` });
    } catch (e) { if (generation.current === current) setError(e instanceof Error ? e.message : "Could not revoke access."); }
    finally { if (generation.current === current) setBusy(false); }
  };
  const remove = async (app: SessionApp) => {
    const current = generation.current;
    setBusy(true); setError(""); setConfirm(null);
    try {
      await controller.appCommand("apps.remove", sessionId, { appId: app.id }, nodeId);
      if (generation.current === current) setRefresh((n) => n + 1);
    } catch (e) { if (generation.current === current) setError(e instanceof Error ? e.message : "Could not remove app."); }
    finally { if (generation.current === current) setBusy(false); }
  };

  if (peek) return <PreviewPeek url={peek.url} name={peek.app.name} sessionId={sessionId} onClose={onClose}
    onOpenInTab={() => { const { app, view } = peek; setPeek(null); void open({ app, view }, "tab"); }} />;
  if (terminal) return <Suspense fallback={<Sheet title="App terminal" onClose={() => setTerminal(null)}><p role="status">Loading terminal…</p></Sheet>}>
    <TerminalOverlay sessionId={sessionId} attachTermId={terminal} attachOnly onClose={() => setTerminal(null)} />
  </Suspense>;
  return <Sheet title="Apps" ariaLabel="Session apps" onClose={onClose} autoFocusSearch={false} size="large"
    headExtra={<button className="btn sm ghost" onClick={() => setRefresh((n) => n + 1)} disabled={busy || !online}>Refresh</button>}>
    <p className="muted">Web views open over the chat; use Open in tab for a full browser tab. Terminal views run here.</p>
    {busy && <p role="status">{result ? "Preparing…" : "Loading apps…"}</p>}
    {error && <p role="alert" className="artifact-unavailable">{error}</p>}
    {result && !result.previewAvailable && <p className="muted">Bivy’s preview service is unavailable. Try Refresh shortly. Terminal views still work.</p>}
    {result?.apps.length === 0 && offers.length === 0 && <div className="changes-binary">No apps yet. When the agent starts a web server in this session’s workspace, it appears here. Agents can also publish views with <code>bivy app publish</code>.</div>}
    {!appId && offers.length > 0 && <section className="artifacts-group" aria-label="Running in this workspace">
      <div className="app-views-heading"><strong className="artifact-name">Running in this workspace</strong></div>
      {offers.map((offer) => <div className="artifact-row app-view-row" key={offer.port}>
        <div className="artifact-main">
          <strong className="artifact-name">Port {offer.port}</strong>
          <span className="artifact-meta">Web · live server · not previewed yet</span>
          <code className="app-view-command">{offer.command}</code>
        </div>
        <div className="app-view-actions">
          <button className="btn sm" disabled={busy || !online || !result?.previewAvailable} onClick={() => void open({ offer })} aria-label={`Preview port ${offer.port}`}>Preview</button>
        </div>
      </div>)}
    </section>}
    {result && appId && !result.apps.some((app) => app.id === appId) && <p role="status">This app is no longer available. Ask the agent to republish it; previews expire when the machine restarts.</p>}
    {result?.apps.filter((app) => !appId || app.id === appId).map((app) => <section className="artifacts-group" key={app.id} aria-label={app.name}>
      <div className="app-views-heading"><strong className="artifact-name">{app.name}</strong>
        <button className="btn sm ghost" disabled={busy || !online} onClick={() => setConfirm({ app })} aria-label={`Remove ${app.name}`}>Remove</button>
      </div>
      {app.views.map((view) => <div className="artifact-row app-view-row" key={view.id}>
        <div className="artifact-main">
          <strong className="artifact-name">{view.name}</strong>
          <span className="artifact-meta">{VIEW_LABELS[view.kind === "terminal" ? "terminal" : view.source === "service" && view.managed ? "managed" : view.source]}</span>
          {view.kind === "terminal" && <code className="app-view-command">{[view.command, ...view.args.map((arg) => JSON.stringify(arg))].join(" ")}</code>}
        </div>
        <div className="app-view-actions">
          {view.kind === "web" && view.address && <button className="btn sm ghost" disabled={busy} onClick={() => void copyAddress(view)} aria-label={`Copy address of ${view.name}`}>Copy address</button>}
          {view.kind === "web" && view.managed && !remote && <button className="btn sm ghost" disabled={busy || !online} onClick={() => void logs(app, view)} aria-label={`${view.source === "display" ? "App" : "Server"} logs for ${view.name}`}>Logs</button>}
          {view.kind === "web" && <>
            <button className="btn sm ghost" disabled={busy || !online || !result.previewAvailable} onClick={() => void revoke(app, view)} aria-label={`Revoke access to ${view.name}`}>Revoke access</button>
            <button className="btn sm ghost" disabled={busy || !online || !result.previewAvailable} onClick={() => void share(app, view)} aria-label={`Copy link to ${view.name}`}>Copy link</button>
          </>}
          {link?.viewId === view.id
            ? <a className="btn sm" href={link.url} target="_blank" rel="noopener noreferrer" onClick={() => setTimeout(onClose, 0)}>Open preview ↗</a>
            : view.kind === "terminal" && remote
              ? <button className="btn sm" onClick={() => { onClose(); onOpenInChat?.(); }}>Open in chat</button>
              : <button className="btn sm" disabled={busy || !online || (view.kind === "web" && !result.previewAvailable)} onClick={() => view.kind === "terminal" ? setConfirm({ app, view }) : void open({ app, view })}>
                {view.kind === "terminal" ? "Open terminal" : "Open preview"}
              </button>}
        </div>
        {view.kind === "web" && view.notes?.length ? <div className="app-view-notice" role="group" aria-label={`Reviewer notes on ${view.name}`}>
          <span className="artifact-meta">{view.notes.length === 1 ? "1 note" : `${view.notes.length} notes`} from people with a shared link</span>
          <ul className="app-view-notes">{view.notes.map((note) => <li key={note.id}>“{note.note}” <span className="artifact-meta">{note.text ? `on “${note.text}”` : note.selector} · {note.path}</span></li>)}</ul>
          <div className="app-view-actions">
            <button className="btn sm ghost" disabled={busy || !online} onClick={() => void clearNotes(app, view)}>Clear</button>
            <button className="btn sm" onClick={() => notesToMessage(view)}>Add to message</button>
          </div>
        </div> : null}
        {notice?.viewId === view.id && <div className="app-view-notice" role="status">
          <span className="artifact-meta">{notice.text}</span>
          {notice.url && <input className="field" readOnly value={notice.url} aria-label={`Link to ${view.name}`} autoFocus onFocus={(e) => e.currentTarget.select()} />}
        </div>}
      </div>)}
    </section>)}
    <p className="muted">Apps are available while this machine is running. Removing an app closes its terminals and revokes preview access; externally started web servers keep running.</p>
    {confirm && <ConfirmDialog
      title={confirm.view ? `Open ${confirm.view.name}?` : `Remove ${confirm.app.name}?`}
      message={confirm.view?.kind === "terminal"
        ? `This starts or reconnects to ${JSON.stringify([confirm.view.command, ...confirm.view.args])}. It runs with the machine user’s permissions, not in a new sandbox. Only run code you trust.`
        : "Preview access will be revoked and this app’s terminals stopped. Project files and externally started servers are not removed."}
      confirmLabel={confirm.view ? "Open terminal" : "Remove app"} danger={!confirm.view}
      onCancel={() => setConfirm(null)} onConfirm={() => { if (confirm.view) void open({ app: confirm.app, view: confirm.view }); else void remove(confirm.app); }}
    />}
  </Sheet>;
}
