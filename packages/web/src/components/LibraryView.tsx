// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// The sidebar's Artifacts and Apps pages: everything the account's machines can
// open right now, across all their sessions — agent-sent files that are still
// stored, and apps that are still published. Offline machines are skipped. Each
// item links back to the message it came from. Opening an app reuses the
// per-session AppsSheet, pointed at the app's machine.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { MachineArtifact, PromptAttachment, SessionApp } from "@bivy/core";
import type { LibraryView as LibraryPage } from "../router.js";
import type { MessageTarget } from "../messageJump.js";
import type { MachineListing, OnMachine } from "../store/controller.js";
import { controller, useAppState } from "../store/useStore.js";
import { useModalEscape } from "../modalStack.js";
import { useModalFocus } from "../useModalFocus.js";
import { AppsSheet } from "./AppsSheet.js";
import { AppRow, appInitial } from "./AppRow.js";
import { downloadAttachment, fmtBytes, useAttachmentUrl } from "./ArtifactsSheet.js";
import { ImageGallery } from "./ImageGallery.js";
import { relTime } from "./SessionList.js";
import { Spinner } from "./Spinner.js";
import { ChatBubbleIcon, CloseIcon } from "./UiIcons.js";

type ShowInChat = (sessionId: string, target: MessageTarget, nodeId: string | null) => void;
/** Where an item came from, for its caption. `machine` only when there are several. */
type Where = (item: { sessionId: string; nodeId: string | null }) => { session: string; machine: string | null };
type Artifact = OnMachine<MachineArtifact>;
type App = OnMachine<SessionApp>;

const PAGES = {
  artifacts: {
    title: "Artifacts",
    sub: "Files your agents sent to chats",
    empty: "Reports, screenshots and builds an agent sends to a chat collect here.",
  },
  apps: {
    title: "Apps",
    sub: "Apps your agents published",
    empty: "When an agent starts a web server or publishes an app, it appears here.",
  },
} as const;

type Load<T> = { status: "loading" } | { status: "ready"; listing: MachineListing<T> } | { status: "error"; error: string };

const loadArtifacts = () => controller.listMachineArtifacts();
const loadApps = () => controller.listMachineApps();
const onAppsChanged = (fn: () => void) => controller.onAppsChanged(fn);

/** Load a listing from every online machine, again when the set of online
 *  machines changes, the app returns to the foreground, or `refreshOn` fires. */
function useMachineListing<T>(load: () => Promise<MachineListing<T>>, refreshOn?: (fn: () => void) => () => void): Load<T> {
  const { connection } = useAppState();
  const machines = [connection.status === "online" ? connection.currentNodeId ?? "direct" : "", ...connection.nodes.filter((n) => n.online).map((n) => n.id)].join(",");
  const [state, setState] = useState<Load<T>>({ status: "loading" });
  useEffect(() => {
    let live = true;
    let generation = 0;
    const run = (quiet: boolean) => {
      const current = ++generation;
      if (!quiet) setState({ status: "loading" });
      load().then(
        (listing) => { if (live && current === generation) setState({ status: "ready", listing }); },
        (e: unknown) => { if (live && current === generation) setState({ status: "error", error: e instanceof Error ? e.message : "Could not load." }); },
      );
    };
    run(false);
    const onVisible = () => { if (document.visibilityState === "visible") run(true); };
    document.addEventListener("visibilitychange", onVisible);
    const off = refreshOn?.(() => run(true));
    return () => {
      live = false;
      document.removeEventListener("visibilitychange", onVisible);
      off?.();
    };
  }, [machines, load, refreshOn]);
  return state;
}

export function LibraryView({ view, onClose, onShowInChat }: { view: LibraryPage; onClose: () => void; onShowInChat: ShowInChat }) {
  const { connection, sessionIndex } = useAppState();
  const page = PAGES[view];
  const ref = useRef<HTMLDivElement>(null);
  // Focus the page itself, so opening it doesn't ring the close button.
  useModalFocus(ref, ref);
  useModalEscape(onClose);
  const several = !controller.direct && connection.nodes.length > 1;
  const where: Where = ({ sessionId, nodeId }) => {
    const rows = sessionIndex.sessions.filter((s) => s.sessionId === sessionId);
    const row = rows.find((s) => s.nodeId === nodeId) ?? rows[0];
    return {
      session: row?.name?.trim() || "Untitled session",
      machine: several && nodeId ? connection.nodes.find((n) => n.id === nodeId)?.name ?? null : null,
    };
  };

  return createPortal(
    <div className="automations-view library-view" role="dialog" aria-modal="true" aria-label={page.title} ref={ref} tabIndex={-1}>
      <header className="automations-view-head">
        <div className="automations-view-head-text">
          <h1 className="automations-view-heading">{page.title}</h1>
          <p className="automations-view-sub">{several ? `${page.sub}, on all your machines.` : `${page.sub}.`}</p>
        </div>
        <div className="automations-view-head-actions">
          <button type="button" className="btn ghost icon autom-close-btn" onClick={onClose} aria-label={`Close ${page.title.toLowerCase()}`}><CloseIcon /></button>
        </div>
      </header>
      <div className="automations-view-body library-body">
        {view === "artifacts"
          ? <ArtifactsPage where={where} onShowInChat={onShowInChat} />
          : <AppsPage where={where} onShowInChat={onShowInChat} />}
      </div>
    </div>,
    document.body,
  );
}

/** Loading, error and empty states shared by both pages, plus a quiet note for
 *  online machines that didn't answer. */
function ListState<T>({ state, empty, children }: { state: Load<T>; empty: string; children: (items: T[]) => ReactNode }) {
  if (state.status === "loading") return <div className="library-state library-loading" role="status"><Spinner size="md" /><span className="sr-only">Loading…</span></div>;
  if (state.status === "error") return <div className="banner" data-tone="danger" role="alert"><div className="banner-text"><strong>Couldn’t load this list</strong><span>{state.error}</span></div></div>;
  const { items, unreachable } = state.listing;
  const note = unreachable.length > 0 && <p className="library-note" role="status">Couldn’t reach {unreachable.join(", ")}. What’s on {unreachable.length === 1 ? "it" : "them"} isn’t shown.</p>;
  if (items.length === 0) return <>{note}<div className="chat-empty library-state"><p className="chat-empty-title">Nothing here yet</p><p className="chat-empty-sub">{empty}</p></div></>;
  return <>{note}{children(items)}</>;
}

/** Opens the chat at the message a file or app came from. */
function SourceLink({ name, at, onClick }: { name: string; at: number; onClick: () => void }) {
  const when = relTime(at);
  return (
    <button type="button" className="library-source" onClick={onClick} title={`Show in chat: ${name}`}>
      <ChatBubbleIcon size={14} aria-hidden />
      <span className="library-source-name"><span className="sr-only">Show in chat: </span>{name}</span>
      {when && <span className="library-source-when">· {when}</span>}
    </button>
  );
}

type Filter = "all" | "image" | "file";
const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "image", label: "Images" },
  { id: "file", label: "Files" },
];

function ArtifactsPage({ where, onShowInChat }: { where: Where; onShowInChat: ShowInChat }) {
  const state = useMachineListing(loadArtifacts);
  const [filter, setFilter] = useState<Filter>("all");
  const [gallery, setGallery] = useState<number | null>(null);
  const all = useMemo(() => state.status === "ready" ? state.listing.items : [], [state]);
  const shown = useMemo(() => filter === "all" ? all : all.filter((a) => a.kind === filter), [all, filter]);
  const images = useMemo(() => shown.filter((a) => a.kind === "image"), [shown]);
  const galleryImages = useMemo<PromptAttachment[]>(() => images.map((a) => ({ kind: "image", name: a.name, size: a.size, mimeType: a.mimeType, hash: a.hash, createdAt: a.createdAt })), [images]);
  const mixed = all.some((a) => a.kind === "image") && all.some((a) => a.kind === "file");

  return (
    <ListState state={state} empty={PAGES.artifacts.empty}>
      {() => <>
        {mixed && (
          <div className="library-toolbar">
            <div className="segmented" role="tablist" aria-label="Show">
              {FILTERS.map((f) => (
                <button key={f.id} type="button" role="tab" className="seg-btn" aria-selected={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}</button>
              ))}
            </div>
          </div>
        )}
        <ul className="library-grid" aria-label="Artifacts">
          {shown.map((artifact) => (
            <ArtifactTile
              key={`${artifact.nodeId}:${artifact.hash}`}
              artifact={artifact}
              where={where(artifact)}
              onView={artifact.kind === "image" ? () => setGallery(images.indexOf(artifact)) : undefined}
              onShowInChat={() => onShowInChat(artifact.sessionId, { hash: artifact.hash }, artifact.nodeId)}
            />
          ))}
        </ul>
        {gallery !== null && <ImageGallery images={galleryImages} index={gallery} onClose={() => setGallery(null)} />}
      </>}
    </ListState>
  );
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 && name.length - dot <= 6 ? name.slice(dot + 1).toUpperCase() : "FILE";
}

function ArtifactTile({ artifact, where, onView, onShowInChat }: { artifact: Artifact; where: ReturnType<Where>; onView?: () => void; onShowInChat: () => void }) {
  const [downloading, setDownloading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const download = async () => {
    setDownloading(true);
    setUnavailable(false);
    const ok = await downloadAttachment(artifact);
    setDownloading(false);
    if (!ok) setUnavailable(true);
  };
  const details = [artifact.name, where.machine && `On ${where.machine}`, artifact.caption].filter(Boolean).join("\n");
  return (
    <li className="library-tile">
      <button
        type="button"
        className="library-tile-preview"
        onClick={onView ?? (() => void download())}
        disabled={downloading}
        aria-busy={downloading}
        aria-label={`${onView ? "View" : "Download"} ${artifact.name}, ${fmtBytes(artifact.size)}${where.machine ? `, on ${where.machine}` : ""}`}
      >
        {artifact.kind === "image" ? <TileImage artifact={artifact} /> : <FileGlyph name={artifact.name} />}
      </button>
      <div className="library-tile-caption">
        <span className="library-tile-name" title={details}>{artifact.name}</span>
        <SourceLink name={where.session} at={artifact.createdAt} onClick={onShowInChat} />
        {unavailable && <span className="library-tile-note" role="status">Not available right now.</span>}
      </div>
    </li>
  );
}

function FileGlyph({ name }: { name: string }) {
  return (
    <span className="library-tile-file" aria-hidden>
      <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></svg>
      <span className="library-tile-ext">{extensionOf(name)}</span>
    </span>
  );
}

function TileImage({ artifact }: { artifact: Artifact }) {
  const state = useAttachmentUrl(artifact);
  if (state.status === "ready") return <img src={state.url} alt="" loading="lazy" />;
  return <span className="library-tile-ext" aria-hidden>{state.status === "unavailable" ? "Unavailable" : ""}</span>;
}

/** How an app shows, from its views: one view names its kind; more count. */
function appSummary(app: SessionApp): string {
  if (app.views.length !== 1) return `${app.views.length} views`;
  const view = app.views[0]!;
  return view.kind === "terminal" ? "Terminal" : view.source === "display" ? "Desktop app" : "Web app";
}

function AppsPage({ where, onShowInChat }: { where: Where; onShowInChat: ShowInChat }) {
  const state = useMachineListing(loadApps, onAppsChanged);
  const [open, setOpen] = useState<App | null>(null);
  const showInChat = (app: App) => onShowInChat(app.sessionId, { appId: app.id }, app.nodeId);
  return (
    <ListState state={state} empty={PAGES.apps.empty}>
      {(apps) => <>
        <ul className="apps-list" aria-label="Apps">
          {apps.map((app) => {
            const from = where(app);
            return (
              <li key={`${app.nodeId}:${app.id}`} className="apps-card">
                <AppRow tile={appInitial(app.name)} name={app.name} meta={[appSummary(app), from.machine].filter(Boolean).join(" · ")}
                  detail={<SourceLink name={from.session} at={app.createdAt} onClick={() => showInChat(app)} />}
                  action={<button type="button" className="btn sm primary" onClick={() => setOpen(app)} aria-label={`Open ${app.name}`}>Open</button>} />
              </li>
            );
          })}
        </ul>
        {open && <AppsSheet sessionId={open.sessionId} appId={open.id} nodeId={open.nodeId} onOpenInChat={() => showInChat(open)} onClose={() => setOpen(null)} />}
      </>}
    </ListState>
  );
}
