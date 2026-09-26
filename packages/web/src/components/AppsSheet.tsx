// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { AppOffer, AppView, OpenAppViewResult, ReviewCardMode, SessionApp, SessionAppOffersResult, SessionAppsResult, ShareAppViewResult } from "@bivy/core";
import { controller, useAppState } from "../store/useStore.js";
import { Sheet } from "./Sheet.js";
import { ConfirmDialog } from "./AppDialog.js";
import { accountOrigin } from "../packaged-client.js";
import { writeClipboard } from "../clipboard.js";
import { PreviewPeek, peekBlocked } from "./PreviewPeek.js";
import { seedSessionDraft } from "../shareTarget.js";
import { useModalEscape } from "../modalStack.js";
import { relTime } from "./SessionList.js";
import { Spinner } from "./Spinner.js";
import { AppRow, appInitial } from "./AppRow.js";
import { CheckIcon, DisplayIcon, GlobeIcon, HomeIcon, LinkIcon, LogsIcon, MoreIcon, RefreshIcon, TerminalIcon } from "./UiIcons.js";
const TerminalOverlay = lazy(() => import("./Terminal.js").then((module) => ({ default: module.TerminalOverlay })));
/** What each kind of view is, in the list. */
const VIEW_LABELS = {
  terminal: "Terminal · starts when opened",
  static: "Snapshot · refreshed after each turn",
  service: "Live server",
  managed: "Live server · run by Bivy",
  display: "Desktop app · own display",
} as const;

/** `nodeId` opens a session's apps on another machine without switching to it.
 *  Terminal views stream over the connected machine's link, so for another
 *  machine they hand off to the chat (`onOpenInChat`), which switches there. */
/** What "Preview cards" means for an app, in its ⋯ menu and on review cards. */
export const REVIEW_MODE_LABELS: Record<ReviewCardMode, string> = { ready: "When ready", every: "Every change", off: "Off" };

/** `openView`: open this view straight away (a review card's Open preview), on `path` if given. */
export function AppsSheet({ sessionId, appId, nodeId, openView, onOpenInChat, onClose }: { sessionId: string; appId?: string; nodeId?: string | null; openView?: { viewId: string; path?: string }; onOpenInChat?: () => void; onClose: () => void }) {
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

  // Reviewer notes and publishes land while the sheet is open: refresh the
  // list only, keeping any link or confirmation on screen.
  useEffect(() => controller.onAppsChanged((changed) => {
    if (changed !== sessionId) return;
    const current = generation.current;
    void controller.appCommand("apps.list", sessionId).then((event) => {
      if (generation.current === current) setResult(event as unknown as SessionAppsResult);
    }, () => {});
  }), [sessionId]);

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
  // A review card's Open preview: go straight to the view once the list is in.
  const opened = useRef(false);
  useEffect(() => {
    if (!openView || opened.current || !result) return;
    const app = result.apps.find((item) => item.views.some((view) => view.id === openView.viewId));
    const view = app?.views.find((item) => item.id === openView.viewId);
    if (!app || !view) return;
    opened.current = true;
    void open({ app, view }, "peek", openView.path);
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

  if (peek) return <PreviewPeek url={peek.url} name={peek.app.name} sessionId={sessionId} appId={peek.app.id} viewId={peek.view.id} onClose={onClose}
    onOpenInTab={() => { const { app, view } = peek; setPeek(null); void open({ app, view }, "tab"); }} />;
  if (terminal) return <Suspense fallback={<Sheet title="App terminal" onClose={() => setTerminal(null)}><p role="status">Loading terminal…</p></Sheet>}>
    <TerminalOverlay sessionId={sessionId} attachTermId={terminal} attachOnly onClose={() => setTerminal(null)} />
  </Suspense>;
  const previewOk = Boolean(result?.previewAvailable);
  const shown = result?.apps.filter((app) => !appId || app.id === appId) ?? [];
  return <Sheet title="Apps" ariaLabel="Session apps" onClose={onClose} autoFocusSearch={false} size="large"
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
            { label: "Remove app…", danger: true, disabled: busy || !online, onSelect: () => setConfirm({ app }), separated: true },
          ]} />} />
        {app.views.map((view) => {
          const kind = view.kind === "terminal" ? "terminal" : view.source === "service" && view.managed ? "managed" : view.source;
          const Icon = view.kind === "terminal" ? TerminalIcon : view.source === "display" ? DisplayIcon : GlobeIcon;
          return <article className="apps-view" key={view.id} aria-label={view.name}>
            <AppRow small tile={<Icon size={18} />} name={view.name} meta={VIEW_LABELS[kind]} action={link?.viewId === view.id
                ? <a className="btn sm primary" href={link.url} target="_blank" rel="noopener noreferrer" onClick={() => setTimeout(onClose, 0)}>Open preview ↗</a>
                : view.kind === "terminal" && remote
                  ? <button className="btn sm" onClick={() => { onClose(); onOpenInChat?.(); }}>Open in chat</button>
                  : <button className={`btn sm${view.kind === "web" ? " primary" : ""}`} disabled={busy || !online || (view.kind === "web" && !previewOk)} onClick={() => view.kind === "terminal" ? setConfirm({ app, view }) : void open({ app, view })}>
                    {view.kind === "terminal" ? "Open terminal" : "Open preview"}
                  </button>} />
            {view.kind === "terminal" && <code className="apps-cmd">{formatCommand(view.command, view.args)}</code>}
            {view.kind === "web" && <div className="apps-view-tools">
              <button className="btn sm ghost" disabled={busy || !online || !previewOk} onClick={() => void share(app, view)} aria-label={`Copy link to ${view.name}`}><LinkIcon size={15} />Copy link</button>
              {view.address && <button className="btn sm ghost" disabled={busy} onClick={() => void copyAddress(view)} aria-label={`Copy address of ${view.name}`}><HomeIcon size={15} />Address</button>}
              {view.managed && !remote && <button className="btn sm ghost" disabled={busy || !online} onClick={() => void logs(app, view)} aria-label={`${view.source === "display" ? "App" : "Server"} logs for ${view.name}`}><LogsIcon size={15} />Logs</button>}
              <MoreMenu label={`More actions for ${view.name}`} items={[{ label: "Revoke access", danger: true, disabled: busy || !online || !previewOk, onSelect: () => void revoke(app, view) }]} />
            </div>}
            {notice?.viewId === view.id && <div className="apps-notice" role="status">
              <CheckIcon size={16} aria-hidden />
              <div className="app-row-text">
                <span>{notice.text}</span>
                {notice.url && <input className="field" readOnly value={notice.url} aria-label={`Link to ${view.name}`} autoFocus onFocus={(e) => e.currentTarget.select()} />}
              </div>
            </div>}
            {view.kind === "web" && view.notes?.length ? <div className="apps-notes" role="group" aria-label={`Reviewer notes on ${view.name}`}>
              <div className="apps-notes-head">
                <span>Reviewer notes</span><span className="apps-count" aria-label={`${view.notes.length} from people with a shared link`}>{view.notes.length}</span>
              </div>
              <ul>{view.notes.map((note) => <li className="apps-note" key={note.id}>
                <span className="apps-note-text">“{note.note}”</span>{" "}
                <span className="app-row-meta">{note.text ? `on “${note.text}”` : note.selector} · {note.path} · {note.viewport.width}×{note.viewport.height}</span>
              </li>)}</ul>
              <div className="apps-notes-actions">
                <button className="btn sm" onClick={() => notesToMessage(view)}>Add to message</button>
                <button className="btn sm ghost" disabled={busy || !online} onClick={() => void clearNotes(app, view)}>Clear</button>
              </div>
            </div> : null}
          </article>;
        })}
      </section>)}

      {(shown.length > 0 || offers.length > 0) && <p className="apps-foot">Web views open over the chat. Apps stay available while this machine runs; removing one closes its terminals and revokes preview access, but leaves project files and servers you started yourself.</p>}
    </div>
    {confirm && <ConfirmDialog
      title={confirm.view ? `Open ${confirm.view.name}?` : `Remove ${confirm.app.name}?`}
      message={confirm.view?.kind === "terminal"
        ? `This starts or reconnects to “${formatCommand(confirm.view.command, confirm.view.args)}”. It runs with the machine user’s permissions, not in a new sandbox. Only run code you trust.`
        : "Preview access will be revoked and this app’s terminals stopped. Project files and externally started servers are not removed."}
      confirmLabel={confirm.view ? "Open terminal" : "Remove app"} danger={!confirm.view}
      onCancel={() => setConfirm(null)} onConfirm={() => { if (confirm.view) void open({ app: confirm.app, view: confirm.view }); else void remove(confirm.app); }}
    />}
  </Sheet>;
}

/** Commands read like a shell line: plain words as-is, anything else quoted. */
export function formatCommand(command: string, args: readonly string[] = []): string {
  return [command, ...args].map((word) => /^[\w@%+=:,./-]+$/.test(word) ? word : JSON.stringify(word)).join(" ");
}

export type MoreItem = { heading: string } | { label: string; danger?: boolean; disabled?: boolean; onSelect: () => void;
  /** A choice among the items after the last heading (menuitemradio). */
  checked?: boolean;
  /** A rule above it, to set it apart from the choices before. */
  separated?: boolean };
/** Rare or destructive actions, and settings, behind a ⋯ button (the canonical .menu). */
export function MoreMenu({ label, items, onOpen }: { label: string; items: MoreItem[]; onOpen?: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useModalEscape(() => setOpen(false), open);
  useEffect(() => {
    if (!open) return;
    ref.current?.querySelector<HTMLButtonElement>("[role^=menuitem]:not(:disabled)")?.focus();
    const onDoc = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, [open]);
  return <div className="apps-more" ref={ref}>
    <button type="button" className="btn ghost icon" aria-label={label} title="More" aria-haspopup="menu" aria-expanded={open}
      onClick={(e) => { e.stopPropagation(); if (!open) onOpen?.(); setOpen((v) => !v); }}><MoreIcon size={18} /></button>
    {open && <div className="menu apps-more-menu" role="menu" aria-label={label}>
      {items.map((item) => "heading" in item
        ? <div key={item.heading} className="menu-heading" role="presentation">{item.heading}</div>
        : <button key={item.label} type="button" role={item.checked === undefined ? "menuitem" : "menuitemradio"} aria-checked={item.checked}
            className={`menu-item${item.danger ? " danger" : ""}${item.separated ? " separated" : ""}`} disabled={item.disabled}
            onClick={() => { setOpen(false); item.onSelect(); }}>
            <span className="menu-item-label">{item.label}</span>{item.checked && <CheckIcon size={15} aria-hidden />}
          </button>)}
    </div>}
  </div>;
}
