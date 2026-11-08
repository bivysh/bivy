// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Panel } from "./Panel.js";
import { Badge } from "./Badge.js";
import { Spinner } from "./Spinner.js";
import { ChevronLeftIcon, CopyIcon, DownloadIcon, RefreshIcon } from "./UiIcons.js";
import { fmtBytes } from "./ArtifactsSheet.js";
import { relTime } from "./ChangesCard.js";
import { controller } from "../store/useStore.js";
import { writeClipboard } from "../clipboard.js";
import { base64ToBlobUrl } from "../attachmentUrl.js";
import { toHtml } from "@bivy/core";
import { decorateCodeBlocks, highlightCode } from "../highlight.js";
import { renderMermaidDiagrams } from "../mermaid.js";
import {
  HIGHLIGHT_MAX_CHARS, STATUS_GLYPH, STATUS_LABEL, isMarkdownPath, languageFor, visibleEntries,
  type WorkspaceEntry, type WorkspaceFile, type WorkspaceListing,
} from "../workspaceFiles.js";

// Files: a read-only browser over the session's workspace on its machine —
// the worktree the agent edits — so you can read what it is working on before
// anything is committed or pushed. Folders load as you open them; uncommitted
// files carry the same + / ~ / − marks as Changes.

type Folder = { status: "loading" } | { status: "ready"; listing: WorkspaceListing } | { status: "error"; error: string };

/** Per session, what was open survives switching tabs or closing the sheet. */
const remembered = new Map<string, { expanded: string[]; open: string | null; changedOnly: boolean }>();

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

function StatusMark({ status }: { status: WorkspaceEntry["status"] }) {
  if (!status) return <span className="files-mark" aria-hidden />;
  return (
    <span className="files-mark" data-status={status} title={STATUS_LABEL[status]}>
      <span aria-hidden>{STATUS_GLYPH[status]}</span>
      <span className="sr-only">{STATUS_LABEL[status]}</span>
    </span>
  );
}

function FileViewer({ sessionId, path, line, reloadKey, onBack }: { sessionId: string; path: string; line?: number; reloadKey: number; onBack: () => void }) {
  const [file, setFile] = useState<WorkspaceFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const codeRef = useRef<HTMLElement>(null);
  const renderedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    controller.fileCommand("files.read", sessionId, path)
      .then((event) => { if (!cancelled) setFile((event as unknown as { file: WorkspaceFile }).file); })
      .catch((e) => { if (!cancelled) { setFile(null); setError(errorText(e)); } });
    return () => { cancelled = true; };
  }, [sessionId, path, reloadKey]);

  const text = file?.kind === "text" ? file.content : null;
  const highlight = text !== null && text.length <= HIGHLIGHT_MAX_CHARS;
  // Markdown opens rendered, the way the chat renders it; Source is the plain
  // file. Past the highlight cap it stays source only, like highlighting.
  const canRender = highlight && !!text && isMarkdownPath(path);
  // Asked for a line: show the source, where lines exist.
  const [rendered, setRendered] = useState(!line);
  useEffect(() => { if (line) setRendered(false); }, [line]);
  const lineRef = useRef<HTMLDivElement>(null);
  const showRendered = canRender && rendered;
  const html = useMemo(() => (canRender && text ? toHtml(text) : ""), [canRender, text]);
  useLayoutEffect(() => {
    const el = codeRef.current;
    if (!el || text === null) return;
    // React owns the text; hljs rewrites it, so reset before highlighting again.
    el.textContent = text;
    delete el.dataset.highlighted;
    if (highlight) highlightCode(el.parentElement?.parentElement ?? null);
  }, [text, highlight, showRendered]);
  useLayoutEffect(() => {
    const el = renderedRef.current;
    if (!el || !showRendered) return;
    renderMermaidDiagrams(el);
    highlightCode(el);
    decorateCodeBlocks(el);
  }, [html, showRendered]);

  const lines = useMemo(() => (text === null ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0)), [text]);
  const markedLine = line && line <= lines && !showRendered ? line : undefined;
  useLayoutEffect(() => { if (markedLine) lineRef.current?.scrollIntoView({ block: "center" }); }, [markedLine, text]);
  const imageUrl = file?.kind === "image" ? `data:${file.mimeType};base64,${file.data}` : null;
  const copyPath = async () => {
    if (!(await writeClipboard(path))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const lang = languageFor(path);
  // The whole file, any kind (the viewer shows at most the first 1 MB of text).
  const download = async () => {
    setDownloading(true);
    setError(null);
    try {
      const event = await controller.fileCommand("files.download", sessionId, path);
      const url = base64ToBlobUrl((event as unknown as { file: { data: string } }).file.data, "application/octet-stream");
      if (!url) throw new Error("Could not prepare the download.");
      const link = document.createElement("a");
      link.href = url;
      link.download = path.split("/").pop() || "file";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="files-viewer">
      <div className="files-viewer-head">
        <button type="button" className="btn ghost icon" onClick={onBack} aria-label="Back to files" title="Back to files">
          <ChevronLeftIcon size={18} />
        </button>
        <span className="files-viewer-path" title={path}>{path}</span>
        <button type="button" className="btn ghost icon" onClick={() => void copyPath()} aria-label={copied ? "Path copied" : "Copy path"} title={copied ? "Copied" : "Copy path"}>
          <CopyIcon size={16} />
        </button>
        <button type="button" className="btn ghost icon" onClick={() => void download()} disabled={downloading} aria-busy={downloading || undefined} aria-label={downloading ? "Downloading file" : "Download file"} title="Download">
          {downloading ? <Spinner size="xs" /> : <DownloadIcon size={16} />}
        </button>
      </div>
      {file && (
        <div className="files-viewer-meta">
          {file.status && <Badge tone={file.status === "deleted" ? "danger" : file.status === "added" ? "ok" : "accent"} variant="soft">{STATUS_LABEL[file.status]}</Badge>}
          <span>{fmtBytes(file.size)}</span>
          {text !== null && <span>{lines} line{lines === 1 ? "" : "s"}</span>}
          {file.mtime > 0 && <span>Saved {relTime(file.mtime)}</span>}
          {canRender && (
            <div className="segmented files-view-toggle" role="radiogroup" aria-label="Show file as">
              {([[true, "Preview"], [false, "Source"]] as const).map(([value, label]) => (
                <button
                  key={label}
                  type="button"
                  role="radio"
                  className="seg-btn"
                  aria-checked={rendered === value}
                  tabIndex={rendered === value ? 0 : -1}
                  onClick={() => setRendered(value)}
                  onKeyDown={(event) => {
                    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                    event.preventDefault();
                    setRendered(!rendered);
                    (event.currentTarget.parentElement?.querySelector(`[aria-checked="false"]`) as HTMLElement | null)?.focus();
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {!file && !error && <div className="apps-state" role="status"><Spinner size="sm" /><span>Opening…</span></div>}
      {error && <div className="banner inline" data-tone="danger" role="alert">{error}</div>}
      {file?.kind === "text" && file.truncated && (
        <div className="banner inline" data-tone="warn" role="status">Showing the first {fmtBytes(file.content.length)} of this file.</div>
      )}
      {file?.kind === "text" && (
        file.content.length === 0
          ? <div className="changes-binary">Empty file.</div>
          : showRendered ? (
            <div className="files-rendered" tabIndex={0} aria-label={`Preview of ${path}`}>
              <div ref={renderedRef} className="msg assistant" dangerouslySetInnerHTML={{ __html: html }} />
            </div>
          ) : (
            <div className="files-code" tabIndex={0} aria-label={`Contents of ${path}`}>
              {markedLine && <div ref={lineRef} className="files-line-mark" style={{ "--line": markedLine } as CSSProperties} aria-hidden />}
              <pre className="files-gutter" aria-hidden>{Array.from({ length: lines }, (_, i) => i + 1).join("\n")}</pre>
              <pre className="files-source"><code ref={codeRef} className={lang ? `language-${lang}` : "nohighlight"} /></pre>
            </div>
          )
      )}
      {imageUrl && <div className="files-image"><img src={imageUrl} alt={path} /></div>}
      {file?.kind === "binary" && <div className="changes-binary">Binary file — not shown.</div>}
      {file?.kind === "too-large" && <div className="changes-binary">Too large to show here.</div>}
    </div>
  );
}

function FolderRows({ path, depth, folders, expanded, changedOnly, onToggle, onOpen }: {
  path: string;
  depth: number;
  folders: Map<string, Folder>;
  expanded: Set<string>;
  changedOnly: boolean;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
}) {
  const folder = folders.get(path);
  const indent = { paddingLeft: `calc(${depth} * var(--space-4) + var(--space-1))` };
  if (!folder || folder.status === "loading") {
    return <div className="files-row files-row-note" style={indent} role="status"><Spinner size="xs" /><span>Loading…</span></div>;
  }
  if (folder.status === "error") return <div className="files-row files-row-note files-row-error" style={indent} role="alert">{folder.error}</div>;
  const entries = visibleEntries(folder.listing.entries, changedOnly);
  if (entries.length === 0) {
    return <div className="files-row files-row-note" style={indent}>{changedOnly ? "No uncommitted changes here." : "Empty folder."}</div>;
  }
  return (
    <>
      {entries.map((entry) => {
        const open = entry.type === "dir" && expanded.has(entry.path);
        return (
          <div key={entry.path} role="none">
            <button
              type="button"
              className="files-row"
              style={indent}
              data-status={entry.status}
              onClick={() => (entry.type === "dir" ? onToggle(entry.path) : onOpen(entry.path))}
              aria-expanded={entry.type === "dir" ? open : undefined}
              disabled={entry.status === "deleted"}
              title={entry.status === "deleted" ? `${entry.path} — deleted` : entry.path}
            >
              <span className="changes-chevron" aria-hidden>{entry.type === "dir" ? (open ? "▾" : "▸") : ""}</span>
              <span className="files-name">{entry.name}{entry.type === "dir" ? "/" : ""}</span>
              {entry.symlink && <span className="files-meta">link</span>}
              {entry.type === "dir" && entry.changed ? <span className="files-meta files-changed">{entry.changed} changed</span> : null}
              {entry.type === "file" && <StatusMark status={entry.status} />}
            </button>
            {open && <FolderRows path={entry.path} depth={depth + 1} folders={folders} expanded={expanded} changedOnly={changedOnly} onToggle={onToggle} onOpen={onOpen} />}
          </div>
        );
      })}
      {folder.listing.entries.length >= 2000 && <div className="files-row files-row-note" style={indent}>Showing the first 2000 entries.</div>}
    </>
  );
}

export function FilesSheet({ sessionId, onClose, docked, refreshKey = 0, openFile }: {
  sessionId: string;
  /** A file to show now (a path the agent named in the chat); `nonce` changes
   *  on every ask, so asking for the same file again reopens it. */
  openFile?: { path: string; line?: number; nonce: number };
  onClose: () => void;
  docked?: boolean;
  /** Changes when the agent may have touched files (a turn ended): reload what is open. */
  refreshKey?: number;
}) {
  const saved = remembered.get(sessionId);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(saved?.expanded ?? []));
  const [open, setOpen] = useState<string | null>(openFile?.path ?? saved?.open ?? null);
  const [openLine, setOpenLine] = useState<number | undefined>(openFile?.line);
  useEffect(() => {
    if (!openFile) return;
    setOpen(openFile.path);
    setOpenLine(openFile.line);
  }, [openFile]);
  const [changedOnly, setChangedOnly] = useState(saved?.changedOnly ?? false);
  const [folders, setFolders] = useState<Map<string, Folder>>(new Map());
  const [reload, setReload] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    remembered.set(sessionId, { expanded: [...expanded], open, changedOnly });
  }, [sessionId, expanded, open, changedOnly]);

  const load = useCallback((path: string, quiet = false) => {
    if (!quiet) setFolders((prev) => new Map(prev).set(path, { status: "loading" }));
    return controller.fileCommand("files.list", sessionId, path)
      .then((event) => setFolders((prev) => new Map(prev).set(path, { status: "ready", listing: event as unknown as WorkspaceListing })))
      .catch((error) => setFolders((prev) => new Map(prev).set(path, { status: "error", error: errorText(error) })));
  }, [sessionId]);

  // The root and every open folder, on open and whenever files may have moved.
  // A refresh keeps the current rows on screen until the new ones land.
  const first = useRef(true);
  useEffect(() => {
    const quiet = !first.current;
    first.current = false;
    setRefreshing(true);
    void Promise.all(["", ...expanded].map((path) => load(path, quiet))).finally(() => setRefreshing(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- expanding loads its own folder
  }, [load, refreshKey, reload]);

  const toggle = (path: string) => {
    const next = new Set(expanded);
    if (next.has(path)) next.delete(path);
    else {
      next.add(path);
      if (folders.get(path)?.status !== "ready") void load(path);
    }
    setExpanded(next);
  };

  const root = folders.get("");
  const git = root?.status === "ready" && root.listing.git;
  const changes = root?.status === "ready" ? root.listing.entries.reduce((n, e) => n + (e.changed ?? (e.status ? 1 : 0)), 0) : 0;

  return (
    <Panel
      docked={docked}
      title="Files"
      ariaLabel="Workspace files"
      onClose={onClose}
      autoFocusSearch={false}
      size="large"
      headExtra={
        <button type="button" className="btn ghost icon" onClick={() => setReload((n) => n + 1)} aria-label="Refresh files" title="Refresh">
          {refreshing && root?.status === "ready" ? <Spinner size="xs" /> : <RefreshIcon size={18} />}
        </button>
      }
    >
      {open ? (
        <FileViewer key={`${open}:${openFile?.nonce ?? 0}`} sessionId={sessionId} path={open} line={openLine} reloadKey={refreshKey + reload} onBack={() => { setOpen(null); setOpenLine(undefined); }} />
      ) : (
        <div className="files-browser">
          {git && (
            <div className="files-toolbar">
              <span className="files-toolbar-meta">{changes === 0 ? "No uncommitted changes" : `${changes} uncommitted change${changes === 1 ? "" : "s"}`}</span>
              <div className="changes-mode" role="group" aria-label="Which files to show">
                <button type="button" className={changedOnly ? "" : "active"} aria-pressed={!changedOnly} onClick={() => setChangedOnly(false)}>All</button>
                <button type="button" className={changedOnly ? "active" : ""} aria-pressed={changedOnly} onClick={() => setChangedOnly(true)}>Changed</button>
              </div>
            </div>
          )}
          <div className="files-tree" role="group" aria-label="Workspace files">
            <FolderRows path="" depth={0} folders={folders} expanded={expanded} changedOnly={changedOnly} onToggle={toggle} onOpen={(path) => { setOpen(path); setOpenLine(undefined); }} />
          </div>
        </div>
      )}
    </Panel>
  );
}
