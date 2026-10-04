// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { AppOffer, AppView, OpenAppViewResult, ReviewCardMode, ReviewerNote, SessionApp, SessionAppOffersResult, SessionAppsResult } from "@bivy/core";
import { controller, useAppState } from "../store/useStore.js";
import { Sheet } from "./Sheet.js";
import { Panel } from "./Panel.js";
import { ConfirmDialog } from "./AppDialog.js";
import { accountOrigin } from "../packaged-client.js";
import { AppAccess } from "./AppAccess.js";
import { PreviewPeek, peekBlocked } from "./PreviewPeek.js";
import { seedSessionDraft } from "../shareTarget.js";
import { markNotesSeen } from "../notesSeen.js";
import { MoreMenu } from "./MoreMenu.js";
import { ImageGallery } from "./ImageGallery.js";
import { noteAttachments, notePictures } from "./reviewerNotes.js";
import { relTime } from "./SessionList.js";
import { Spinner } from "./Spinner.js";
import { AppRow, appInitial } from "./AppRow.js";
import { DisplayIcon, GlobeIcon, LogsIcon, RefreshIcon, TerminalIcon } from "./UiIcons.js";
import { BackendView } from "./BackendView.js";
const TerminalOverlay = lazy(() => import("./Terminal.js").then((module) => ({ default: module.TerminalOverlay })));
const stayPut = () => {};
/** What each kind of view is, in the list. */
const VIEW_LABELS = {
  terminal: "Terminal · starts when opened",
  static: "Snapshot · refreshed after each turn",
  service: "Live server",
  managed: "Live server · run by Bivy",
  display: "Desktop app · own display",
} as const;
/** Backend views, in the list: what each shows. */
const BACKEND_LABELS = { requests: "Requests · the API as buttons", data: "Data · rows from saved queries", logs: "Logs · the server's output" } as const;
const BACKEND_OPEN = { requests: "Open requests", data: "Open data", logs: "Open logs" } as const;

/** `nodeId` opens a session's apps on another machine without switching to it.
 *  Terminal views stream over the connected machine's link, so for another
 *  machine they hand off to the chat (`onOpenInChat`), which switches there. */
/** What "Preview cards" means for an app, in its ⋯ menu and on review cards. */
export const REVIEW_MODE_LABELS: Record<ReviewCardMode, string> = { ready: "When ready", every: "Every change", off: "Off" };

/** Reviewer notes as a message draft. Untrusted text: it only ever becomes a draft the owner sends. */
export function notesDraft(viewName: string, notes: readonly ReviewerNote[]): string {
  return `Notes from people reviewing "${viewName}":\n` + notes.map((n) =>
    `- "${n.note}" on ${n.selector}${n.text ? ` ("${n.text}")` : ""}, page ${n.path}, viewport ${n.viewport.width}×${n.viewport.height}${n.context ? `\n${n.context}` : ""}${n.shot ? "\nAttached picture is approximate: retaken on the machine, not the reviewer’s browser." : ""}`).join("\n");
}

/** `openView`: open this view straight away (a review card's Open preview), on `path` if given. */
/** `docked`: in the side pane beside the chat. Previews then open in the pane
 *  too, and handing something to the composer leaves the pane as it is. */
export function AppsSheet({ sessionId, appId, nodeId, openView, onOpenInChat, onClose, docked }: { sessionId: string; appId?: string; nodeId?: string | null; openView?: { viewId: string; path?: string; item?: string }; onOpenInChat?: () => void; onClose: () => void; docked?: boolean }) {
  // Done with the list: a sheet gets out of the way; the pane stays.
  const done = docked ? stayPut : onClose;
  const { connection, activeSession } = useAppState();
  const [picture, setPicture] = useState<ReviewerNote | null>(null);
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
  const [backend, setBackend] = useState<{ app: SessionApp; view: AppView & { kind: "backend" }; item?: string } | null>(null);
  const [peek, setPeek] = useState<{ url: string; app: SessionApp; view: AppView } | null>(null);
  const [previewRevoked, setPreviewRevoked] = useState(false);
  const [link, setLink] = useState<{ viewId: string; url: string } | null>(null);
  const [confirm, setConfirm] = useState<{ app: SessionApp; view?: AppView } | null>(null);
  const generation = useRef(0);
  // Another machine's reachability shows up as a request error instead.
  const online = remote || connection.status === "online";

  // A network blip must not unmount the PTY renderer: it owns reconnect and
  // scrollback replay. Only changing the session/machine leaves that view.
  useEffect(() => { setTerminal(null); }, [sessionId, connection.currentNodeId]);

  useEffect(() => {
    const current = ++generation.current;
    setBusy(true); setError(""); setResult(null); setLink(null); setConfirm(null);
    setOffers([]);
    // Discovery may scan processes/ports. Never hold a published preview behind it.
    if (!appId) void controller.appCommand("apps.offers", sessionId, {}, nodeId).then((event) => {
      if (generation.current === current) setOffers((event as unknown as SessionAppOffersResult).offers ?? []);
    }, () => {});
    void controller.appCommand("apps.list", sessionId, {}, nodeId).then((event) => {
      if (generation.current !== current) return;
      setResult(event as unknown as SessionAppsResult);
    }).catch((e: unknown) => {
      if (generation.current === current) setError(e instanceof Error ? e.message : "Could not load apps.");
    }).finally(() => { if (generation.current === current) setBusy(false); });
    return () => { generation.current = current + 1; };
  }, [sessionId, machine, online, refresh, nodeId, appId]);

  // Reviewer notes and publishes land while the sheet is open: refresh the
  // list only, keeping any link or confirmation on screen.
  useEffect(() => controller.onAppsChanged((changed) => {
    if (changed !== sessionId) return;
    const current = generation.current;
    void controller.appCommand("apps.list", sessionId, {}, nodeId).then((event) => {
      if (generation.current === current) setResult(event as unknown as SessionAppsResult);
    }, () => {});
  }), [sessionId, nodeId]);

  // The sheet lists every note, so opening it clears the Apps pill's "new".
  useEffect(() => {
    const times = result?.apps.flatMap((app) => app.views.flatMap((view) => view.kind === "web" ? (view.notes ?? []).map((note) => note.at) : [])) ?? [];
    if (times.length) markNotesSeen(sessionId, Math.max(...times));
  }, [result, sessionId]);

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
  const open = async (target: { app: SessionApp; view: AppView } | { offer: AppOffer }, mode: "peek" | "tab" = "peek", path?: string) => {
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
      const response = await controller.appCommand("apps.open", sessionId, { appId: app.id, viewId: view.id, returnTo: `${accountOrigin()}/sessions/${encodeURIComponent(sessionId)}`, ...(path ? { path } : {}) }, nodeId) as unknown as OpenAppViewResult;
      if (generation.current !== current) { popup?.close(); return; }
      if (response.kind === "terminal") setTerminal(response.termId);
      else if (response.kind === "web") {
        const url = previewUrl(response.url);
        if (!inTab) { setPreviewRevoked(false); setPeek({ url, app, view }); }
        else if (popup && !popup.closed) { popup.location.replace(url); done(); }
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
  // A review card's Open preview: go straight to the view once the list is in.
  const opened = useRef(false);
  useEffect(() => {
    if (!openView || opened.current || !result) return;
    const app = result.apps.find((item) => item.views.some((view) => view.id === openView.viewId));
    const view = app?.views.find((item) => item.id === openView.viewId);
    if (!app || !view) return;
    opened.current = true;
    if (view.kind === "backend") setBackend({ app, view, item: openView.item });
    else void open({ app, view }, "peek", openView.path);
  }, [openView, result]); // eslint-disable-line react-hooks/exhaustive-deps
  const setReviewMode = async (app: SessionApp, mode: ReviewCardMode) => {
    setError("");
    try {
      await controller.appCommand("apps.reviewMode", sessionId, { appId: app.id, mode }, nodeId);
      setResult((prev) => prev && { ...prev, apps: prev.apps.map((item) => item.id === app.id ? { ...item, reviewMode: mode } : item) });
    } catch (e) { setError(e instanceof Error ? e.message : "Could not change preview cards."); }
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
  /** Reviewer notes are untrusted text: they only ever become a draft. */
  const notesToMessage = async (view: AppView & { kind: "web" }) => {
    setBusy(true); setError("");
    try {
      const notes = view.notes ?? [], text = notesDraft(view.name, notes);
      const attachments = await noteAttachments(notes);
      if (remote || activeSession.activeSessionId !== sessionId || !controller.prefillComposer(text, attachments)) {
        if (attachments.length) throw new Error("Open this session’s chat before adding reviewer pictures.");
        seedSessionDraft(localStorage, sessionId, text);
      }
      done();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not add notes."); }
    finally { setBusy(false); }
  };
  /** The owner's choice: `bivy app notes` works only on apps where this is on. */
  const setAgentNotes = async (app: SessionApp, enabled: boolean) => {
    setError("");
    try {
      await controller.appCommand("apps.agentNotes", sessionId, { appId: app.id, enabled }, nodeId);
      setResult((prev) => prev && { ...prev, apps: prev.apps.map((item) => item.id === app.id ? { ...item, agentNotes: enabled || undefined } : item) });
    } catch (e) { setError(e instanceof Error ? e.message : "Could not change who can read notes."); }
  };
  const clearNotes = async (app: SessionApp, view: AppView) => {
    const current = generation.current;
    setBusy(true); setError("");
    try { await controller.appCommand("apps.clearNotes", sessionId, { appId: app.id, viewId: view.id }, nodeId); if (generation.current === current) setRefresh((n) => n + 1); }
    catch (e) { if (generation.current === current) setError(e instanceof Error ? e.message : "Could not clear notes."); }
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

  if (peek) return <PreviewPeek docked={docked} url={peek.url} name={peek.app.name} sessionId={sessionId} appId={peek.app.id} viewId={peek.view.id} onClose={done}
    access={<AppAccess sessionId={sessionId} appId={peek.app.id} viewId={peek.view.id} name={peek.view.name} nodeId={nodeId} disabled={!online || !result?.previewAvailable} onRevoked={() => setPreviewRevoked(true)} />}
    revoked={previewRevoked}
    onManage={() => setPeek(null)}
    onOpenInTab={() => { const { app, view } = peek; setPeek(null); void open({ app, view }, "tab"); }} />;
  // A backend view's draft goes to the composer, like reviewer notes do.
  const toMessage = (text: string) => {
    if (remote || activeSession.activeSessionId !== sessionId || !controller.prefillComposer(text)) seedSessionDraft(localStorage, sessionId, text);
    done();
  };
  if (backend) return <BackendView sessionId={sessionId} nodeId={nodeId} app={backend.app} view={backend.view} item={backend.item} docked={docked} online={online}
    onBack={() => setBackend(null)} onClose={onClose} onDraft={toMessage} />;
  if (terminal) return <Suspense fallback={<Sheet title="App terminal" onClose={() => setTerminal(null)}><p role="status">Loading terminal…</p></Sheet>}>
    <TerminalOverlay sessionId={sessionId} attachTermId={terminal} attachOnly onClose={() => setTerminal(null)} />
  </Suspense>;
  const previewOk = Boolean(result?.previewAvailable);
  const shown = result?.apps.filter((app) => !appId || app.id === appId) ?? [];
  return <Panel docked={docked} title="Apps" ariaLabel="Session apps" onClose={onClose} autoFocusSearch={false} size="large"
    headExtra={<button className="btn ghost icon" onClick={() => setRefresh((n) => n + 1)} disabled={busy || !online} aria-label="Refresh" title="Refresh">
      {busy && result ? <Spinner size="xs" /> : <RefreshIcon size={18} />}
    </button>}>
    <div className="apps-sheet">
      {busy && !result && <div className="apps-state" role="status"><Spinner size="sm" /><span>Loading apps…</span></div>}
      {busy && result && <span className="sr-only" role="status">Preparing…</span>}
      {error && <div className="banner inline" data-tone="danger" role="alert">{error}</div>}
      {result && !previewOk && <div className="banner inline" data-tone="warn" role="status">Bivy’s preview service is unavailable. Try Refresh shortly. Terminal views still work.</div>}
      {result && appId && !result.apps.some((app) => app.id === appId) && <div className="banner inline" data-tone="neutral" role="status">This app is no longer available. Ask the agent to republish it; previews expire when the machine restarts.</div>}
      {result?.apps.length === 0 && offers.length === 0 && <div className="apps-empty">
        <span className="app-tile" aria-hidden><GlobeIcon size={20} /></span>
        <strong>No apps yet</strong>
        <p>When the agent starts a web server in this session’s workspace, it shows up here. Agents can also publish views with <code>bivy app publish</code>.</p>
      </div>}

      {!appId && offers.length > 0 && <section className="apps-group" aria-label="Running in this workspace">
        <h3 className="apps-group-title">Running in this workspace</h3>
        {offers.map((offer) => <div className="apps-card" key={offer.port}>
          <AppRow tile={<span className="app-tile-port">{offer.port}</span>} name={`Port ${offer.port}`} meta="Live server · not previewed yet"
            action={<button className="btn sm primary" disabled={busy || !online || !previewOk} onClick={() => void open({ offer })} aria-label={`Preview port ${offer.port}`}>Preview</button>} />
          <code className="apps-cmd">{offer.command}</code>
        </div>)}
      </section>}

      {shown.map((app) => <section className="apps-card" key={app.id} aria-label={app.name}>
        <AppRow tile={appInitial(app.name)} name={app.name}
          meta={`${app.views.length === 1 ? "1 view" : `${app.views.length} views`}${app.createdAt ? ` · published ${relTime(app.createdAt)} ago` : ""}`}
          action={<MoreMenu label={`More actions for ${app.name}`} items={[
            { heading: "Preview cards in chat" },
            ...(["ready", "every", "off"] as const).map((mode) => ({ label: REVIEW_MODE_LABELS[mode], checked: (app.reviewMode ?? "ready") === mode, disabled: busy || !online, onSelect: () => void setReviewMode(app, mode) })),
            ...(app.views.some((view) => view.kind === "web") ? [{ heading: "Reviewer notes" }, { label: "Agents can read notes", toggle: true, checked: app.agentNotes === true, disabled: busy || !online, onSelect: () => void setAgentNotes(app, app.agentNotes !== true) }] : []),
            { label: "Remove app…", danger: true, disabled: busy || !online, onSelect: () => setConfirm({ app }), separated: true },
          ]} />} />
        {app.views.map((view) => {
          if (view.kind === "backend") return <article className="apps-view" key={view.id} aria-label={view.name}>
            <AppRow small tile={<LogsIcon size={18} />} name={view.name} meta={BACKEND_LABELS[view.backend]}
              action={<button className="btn sm" disabled={busy || !online} onClick={() => setBackend({ app, view })}>{BACKEND_OPEN[view.backend]}</button>} />
            <code className="apps-cmd">{view.detail}</code>
          </article>;
          const kind = view.kind === "terminal" ? "terminal" : view.source === "service" && view.managed ? "managed" : view.source;
          const Icon = view.kind === "terminal" ? TerminalIcon : view.source === "display" ? DisplayIcon : GlobeIcon;
          return <article className="apps-view" key={view.id} aria-label={view.name}>
            <AppRow small tile={<Icon size={18} />} name={view.name} meta={VIEW_LABELS[kind]} action={link?.viewId === view.id
                ? <a className="btn sm primary" href={link.url} target="_blank" rel="noopener noreferrer" onClick={() => setTimeout(done, 0)}>Open preview ↗</a>
                : view.kind === "terminal" && remote
                  ? <button className="btn sm" onClick={() => { done(); onOpenInChat?.(); }}>Open in chat</button>
                  : <button className={`btn sm${view.kind === "web" ? " primary" : ""}`} disabled={busy || !online || (view.kind === "web" && !previewOk)} onClick={() => view.kind === "terminal" ? setConfirm({ app, view }) : void open({ app, view })}>
                    {view.kind === "terminal" ? "Open terminal" : "Open preview"}
                  </button>} />
            {view.kind === "terminal" && <code className="apps-cmd">{formatCommand(view.command, view.args)}</code>}
            {view.kind === "web" && <div className="apps-view-tools">
              <AppAccess sessionId={sessionId} appId={app.id} viewId={view.id} name={view.name} nodeId={nodeId} address={view.address} disabled={busy || !online || !previewOk} onRevoked={() => setLink(null)} />
              {view.managed && !remote && <button className="btn sm ghost" disabled={busy || !online} onClick={() => void logs(app, view)} aria-label={`${view.source === "display" ? "App" : "Server"} logs for ${view.name}`}><LogsIcon size={15} />Logs</button>}
            </div>}
            {view.kind === "web" && view.notes?.length ? <div className="apps-notes" role="group" aria-label={`Reviewer notes on ${view.name}`}>
              <div className="apps-notes-head">
                <span>Reviewer notes</span><span className="apps-count" aria-label={`${view.notes.length} from people with a shared link`}>{view.notes.length}</span>
              </div>
              <ul>{view.notes.map((note) => <li className="apps-note" key={note.id}>
                <span className="apps-note-text">“{note.note}”</span>{" "}
                <span className="app-row-meta">{note.text ? `on “${note.text}”` : note.selector} · {note.path} · {note.viewport.width}×{note.viewport.height}</span>
                {note.shot && <button className="btn sm ghost" onClick={() => setPicture(note)}>View approximate picture</button>}
              </li>)}</ul>
              <div className="apps-notes-actions">
                <button className="btn sm" disabled={busy || !online} onClick={() => void notesToMessage(view)}>Add to message</button>
                <button className="btn sm ghost" disabled={busy || !online} onClick={() => void clearNotes(app, view)}>Clear</button>
              </div>
            </div> : null}
          </article>;
        })}
      </section>)}

      {(shown.length > 0 || offers.length > 0) && <p className="apps-foot">Apps stay available while this machine runs. Removing an app keeps your project files.</p>}
    </div>
    {picture && <ImageGallery images={notePictures([picture])} index={0} onClose={() => setPicture(null)} />}
    {confirm && <ConfirmDialog
      title={confirm.view ? `Open ${confirm.view.name}?` : `Remove ${confirm.app.name}?`}
      message={confirm.view?.kind === "terminal"
        ? `This starts or reconnects to “${formatCommand(confirm.view.command, confirm.view.args)}”. It runs with the machine user’s permissions, not in a new sandbox. Only run code you trust.`
        : "Preview access will be revoked and this app’s terminals stopped. Project files and externally started servers are not removed."}
      confirmLabel={confirm.view ? "Open terminal" : "Remove app"} danger={!confirm.view}
      onCancel={() => setConfirm(null)} onConfirm={() => { if (confirm.view) void open({ app: confirm.app, view: confirm.view }); else void remove(confirm.app); }}
    />}
  </Panel>;
}

/** Commands read like a shell line: plain words as-is, anything else quoted. */
export function formatCommand(command: string, args: readonly string[] = []): string {
  return [command, ...args].map((word) => /^[\w@%+=:,./-]+$/.test(word) ? word : JSON.stringify(word)).join(" ");
}
