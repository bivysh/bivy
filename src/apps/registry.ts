// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import type { AppManifest, AppView, DisplayStats, LogLine, ReviewCardMode, ReviewerNote, SessionApp } from "./types.js";
import { REVIEW_CARD_MODES } from "./types.js";

const MAX_BYTES = 25 * 1024 * 1024;
/** Reviewer notes kept per view; the oldest drop first. */
export const MAX_NOTES = 50;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_FILES = 2000;
type StaticTarget = { kind: "static"; files: Map<string, Buffer>; bytes: number };
type Command = { command: string; args: string[]; workspace: string };
/** Backend views read files in `dir` (inside the workspace) or a source of output. */
export type BackendTarget =
  | { kind: "requests"; dir: string; base?: { url: string } | { view: string } }
  | ({ kind: "data"; dir: string } & Command)
  | { kind: "logs"; source: { view?: string } | Command };
export type AppTarget = StaticTarget | { kind: "service"; port: number; start?: Command } | ({ kind: "terminal" } & Command) | ({ kind: "display"; restartOnChange: boolean } & Command) | BackendTarget;
/** What survives a node restart: the manifest and the IDs chat links point at. */
interface Persisted { sessionId: string; workspace: string; manifest: AppManifest; id: string; viewIds: string[]; createdAt: number; reviewMode?: ReviewCardMode; agentNotes?: boolean;
  /** Reviewer notes per view ID, so a restart doesn't lose unread feedback. */
  notes?: Record<string, ReviewerNote[]> }
type Restore = { id: string; viewIds: string[]; createdAt: number; reviewMode?: ReviewCardMode; agentNotes?: boolean; notes?: Record<string, ReviewerNote[]> };
/** Stored notes are re-read from disk: keep only well-formed ones, bounded as when they arrived. */
const isNote = (value: unknown): value is ReviewerNote => {
  const note = value as Partial<ReviewerNote> | undefined;
  return !!note && typeof note.id === "string" && typeof note.at === "number" && typeof note.note === "string" && note.note.length <= 1000
    && typeof note.selector === "string" && typeof note.text === "string" && typeof note.path === "string"
    && typeof note.viewport?.width === "number" && typeof note.viewport?.height === "number"
    && (note.context === undefined || (typeof note.context === "string" && note.context.length <= 8000))
    && (note.shot === undefined || (typeof note.shot?.hash === "string" && /^[a-f0-9]{64}$/.test(note.shot.hash) && Number.isFinite(note.shot.size) && Number.isFinite(note.shot.width) && Number.isFinite(note.shot.height)));
};
export interface RegisteredView {
  app: SessionApp; view: AppView; target: AppTarget;
  /** The session workspace it was published from. */
  workspace: string;
  /** Bumped when an agent turn changes files, so open previews reload. */
  revision: number;
  /** Last page the preview shell framed; a reload returns there, not to `/`. */
  lastPath?: string;
  /** Reviewer notes from shared links, newest last, capped. */
  notes?: ReviewerNote[];
  /** Recent screenshots for Compare and review cards, newest last (agent screenshots on only). */
  shots?: { revision: number; at: number; png: Buffer; path?: string }[];
  /** When the preview was last opened: the view Show me picks by default. */
  openedAt?: number;
  /** Where a static snapshot came from, so a turn can re-take it. */
  source?: { workspace: string; directory: string };
  /** A running display view's private VNC socket; the gateway streams it. */
  display?: string;
  /** Its control socket, when the display can read and choose the app's menus. */
  displayControl?: string;
  /** Device pixels per CSS pixel its display runs at (set when it starts). */
  displayScale?: number;
  /** The last viewer's stream measurements. */
  stats?: DisplayStats;
  /** When the preview last loaded a page: the start of "since this page loaded". */
  loadedAt?: number;
}

const sameFiles = (a: Map<string, Buffer>, b: Map<string, Buffer>) => a.size === b.size && [...a].every(([key, data]) => b.get(key)?.equals(data));

/** Snapshot, not a live filesystem server: symlinks and hidden files are never published. */
function snapshot(workspace: string, directory: string): StaticTarget {
  const base = fs.realpathSync(workspace);
  const root = fs.realpathSync(path.resolve(base, directory));
  const relative = path.relative(base, root);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Static directory must be inside the session workspace.");
  if (!fs.statSync(root).isDirectory()) throw new Error("Static entry must be a directory.");
  const files = new Map<string, Buffer>();
  let bytes = 0;
  let entries = 0;
  function walk(dir: string, prefix: string, depth: number) {
    if (depth > 32) throw new Error("Static directory is too deeply nested.");
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (++entries > MAX_FILES * 2) throw new Error("Static directory contains too many entries.");
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      const key = `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error("Static snapshots cannot contain symlinks.");
      if (entry.isDirectory()) walk(full, key, depth + 1);
      else if (entry.isFile()) {
        if (files.size >= MAX_FILES) throw new Error("Static snapshot exceeds 2,000 files.");
        // O_NOFOLLOW closes the final-component symlink race. Verify the opened
        // file's size, then bound the read even if another process grows it.
        const fd = fs.openSync(full, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        try {
          const stat = fs.fstatSync(fd);
          const resolved = fs.realpathSync(full);
          const rel = path.relative(root, resolved);
          const current = fs.statSync(resolved);
          if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) || !stat.isFile() || stat.dev !== current.dev || stat.ino !== current.ino) throw new Error("Static file changed or escaped its directory during publication.");
          const size = stat.size;
          if (bytes + size > MAX_BYTES) throw new Error("Static snapshot exceeds 25 MiB.");
          const data = Buffer.alloc(size);
          let offset = 0;
          while (offset < size) {
            const n = fs.readSync(fd, data, offset, size - offset, offset);
            if (!n) break;
            offset += n;
          }
          files.set(key, data.subarray(0, offset));
          bytes += offset;
        } finally { fs.closeSync(fd); }
      } else throw new Error("Static snapshots can only contain regular files.");
    }
  }
  walk(root, "", 0);
  if (!files.has("/index.html")) throw new Error("Static directory needs an index.html entry point.");
  return { kind: "static", files, bytes };
}

function command(spec: unknown, workspace: string, label: string): Command {
  const value = spec as { command?: unknown; args?: unknown };
  if (typeof value?.command !== "string" || !value.command.trim() || value.command.length > 1000 || value.command.includes("\u0000")) throw new Error(`${label} requires an executable command.`);
  if (value.args !== undefined && (!Array.isArray(value.args) || value.args.length > 100 || value.args.some((arg) => typeof arg !== "string" || arg.length > 4000 || arg.includes("\u0000")))) throw new Error(`Invalid ${label.toLowerCase()} arguments.`);
  return { command: value.command, args: [...(value.args as string[] | undefined ?? [])], workspace: fs.realpathSync(workspace) };
}

/** Apps persist (with their IDs) when given a file, so chat launchers and
 * preview addresses survive restarts. Views whose server Bivy doesn't own —
 * a service without `start` — are not restored: a reused local port could
 * belong to anything by then. Detection offers them again. */
/** A folder for a backend view's files: inside the workspace, never above it. */
function inside(workspace: string, dir: unknown, fallback: string): string {
  const relative = dir === undefined ? fallback : dir;
  if (typeof relative !== "string" || !relative || relative.length > 300 || path.isAbsolute(relative)) throw new Error("A backend view's dir is a folder inside the workspace, like .bivy/requests.");
  const resolved = path.resolve(workspace, relative);
  const from = path.relative(path.resolve(workspace), resolved);
  if (from === ".." || from.startsWith(`..${path.sep}`)) throw new Error("A backend view's dir must be inside the workspace.");
  return resolved;
}
function backendTarget(spec: Extract<AppManifest["views"][number], { kind: "requests" | "data" | "logs" }>, workspace: string): BackendTarget {
  if (spec.kind === "requests") {
    const base = spec.base as { url?: unknown; view?: unknown } | undefined;
    if (base !== undefined) {
      if (typeof base.url === "string") {
        const url = new URL(base.url);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("A requests view's base.url is an http(s) address without credentials.");
        return { kind: "requests", dir: inside(workspace, spec.dir, ".bivy/requests"), base: { url: url.href.replace(/\/$/, "") } };
      }
      if (typeof base.view !== "string" || !base.view) throw new Error("A requests view's base is {\"url\": …} or {\"view\": \"<web view name>\"}.");
      return { kind: "requests", dir: inside(workspace, spec.dir, ".bivy/requests"), base: { view: base.view } };
    }
    return { kind: "requests", dir: inside(workspace, spec.dir, ".bivy/requests") };
  }
  if (spec.kind === "data") return { kind: "data", dir: inside(workspace, spec.dir, ".bivy/queries"), ...command(spec, workspace, "Data view") };
  const source = spec.source as { view?: unknown; file?: unknown; command?: unknown } | undefined;
  if (!source) return { kind: "logs", source: {} };
  if (typeof source.view === "string") return { kind: "logs", source: { view: source.view } };
  // A file is followed the way a person would: tail -F, from the last lines.
  if (typeof source.file === "string") return { kind: "logs", source: { command: "tail", args: ["-n", "200", "-F", path.relative(workspace, inside(workspace, source.file, ""))], workspace: fs.realpathSync(workspace) } };
  return { kind: "logs", source: command(source, workspace, "Logs view") };
}
/** Where a backend view reads from, in words, for its row in the Apps sheet. */
function backendDetail(target: BackendTarget): string {
  const line = (spec: Command) => [spec.command, ...spec.args].join(" ").slice(0, 120);
  if (target.kind === "requests") return `${path.basename(target.dir)} · ${target.base && "url" in target.base ? target.base.url : target.base ? target.base.view : "the app's server"}`;
  if (target.kind === "data") return line(target);
  return "command" in target.source ? line(target.source) : target.source.view ? `${target.source.view} output` : "the app's server output";
}

export class AppRegistry extends EventEmitter {
  /** Errors a web view's server logged since `since` (set by the backend
   *  views, which follow server output; asked by the gateway for the Console). */
  serverErrors?: (viewId: string, since: number) => { now: number; lines: LogLine[] };
  private apps = new Map<string, SessionApp>();
  private views = new Map<string, RegisteredView>();
  private persisted = new Map<string, Persisted>();
  constructor(private readonly reservedPorts: number[] = [], private readonly file?: string) {
    super(); this.setMaxListeners(0);
    this.restore();
  }

  private restore(): void {
    if (!this.file) return;
    let records: Persisted[] = [];
    try { records = JSON.parse(fs.readFileSync(this.file, "utf8")); } catch { return; }
    for (const record of Array.isArray(records) ? records : []) {
      const keep = record.manifest?.views?.map((spec, i) => ({ spec, id: record.viewIds?.[i] }))
        .filter(({ spec, id }) => typeof id === "string" && !(spec?.kind === "web" && spec.source?.kind === "service" && !spec.source.start)) ?? [];
      if (!keep.length) continue;
      // A workspace that moved or a build that vanished drops that app, not the rest.
      try {
        this.publish(record.sessionId, record.workspace, { ...record.manifest, views: keep.map((k) => k.spec) }, { id: record.id, viewIds: keep.map((k) => k.id!), createdAt: record.createdAt, reviewMode: record.reviewMode, agentNotes: record.agentNotes, notes: record.notes });
      } catch { /* skipped */ }
    }
    this.save();
  }
  private save(): void {
    if (!this.file) return;
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify([...this.persisted.values()]), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch { try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ } }
  }

  publish(sessionId: string, workspace: string, input: AppManifest, restore?: Restore): SessionApp {
    const name = (value: unknown): string => {
      if (typeof value !== "string" || !value.trim() || value.length > 100) throw new Error("App and view names must contain 1–100 characters.");
      return value.trim();
    };
    if (!input || input.version !== 1 || !Array.isArray(input.views) || !input.views.length || input.views.length > 8) throw new Error("Expected manifest version 1 with 1–8 views.");
    if (this.apps.size >= 50) throw new Error("Remove an app before publishing more (limit: 50).");
    const id = (i?: number) => (i === undefined ? restore?.id : restore?.viewIds[i]) ?? randomBytes(16).toString("hex");
    const app: SessionApp = { id: id(), sessionId, name: name(input.name), views: [], createdAt: restore?.createdAt ?? Date.now(), ...(restore?.reviewMode && REVIEW_CARD_MODES.includes(restore.reviewMode) ? { reviewMode: restore.reviewMode } : {}), ...(restore?.agentNotes === true ? { agentNotes: true } : {}) };
    const entries: RegisteredView[] = [];
    let total = [...this.views.values()].reduce((sum, item) => sum + (item.target.kind === "static" ? item.target.bytes : 0), 0);
    for (const [index, spec] of input.views.entries()) {
      const base = { id: id(index), name: name(spec?.name) };
      let target: AppTarget;
      let view: AppView;
      let source: RegisteredView["source"];
      if (spec.kind === "web" && spec.source?.kind === "service") {
        const port = spec.source.port;
        if (!Number.isInteger(port) || port < 1024 || port > 65535 || this.reservedPorts.includes(port)) throw new Error("Choose a non-reserved local service port between 1024 and 65535.");
        const start = spec.source.start === undefined ? undefined : command(spec.source.start, workspace, "Service start");
        target = { kind: "service", port, start };
        view = { ...base, kind: "web", source: "service", ...(start ? { managed: true } : {}) };
      } else if (spec.kind === "web" && spec.source?.kind === "static") {
        if (typeof spec.source.directory !== "string" || !spec.source.directory) throw new Error("Static directory is required.");
        target = snapshot(workspace, spec.source.directory);
        source = { workspace, directory: spec.source.directory };
        total += target.bytes;
        if (total > MAX_TOTAL_BYTES) throw new Error("Static apps exceed the node's 100 MiB snapshot budget.");
        view = { ...base, kind: "web", source: "static" };
      } else if (spec.kind === "terminal") {
        target = { kind: "terminal", ...command(spec, workspace, "Terminal view") };
        view = { ...base, kind: "terminal", command: target.command, args: target.args };
      } else if (spec.kind === "display") {
        // Shown through the web preview: Bivy's viewer streams the display.
        target = { kind: "display", ...command(spec, workspace, "Display view"), restartOnChange: spec.restartOnChange === true };
        view = { ...base, kind: "web", source: "display", managed: true };
      } else if (spec.kind === "requests" || spec.kind === "data" || spec.kind === "logs") {
        target = backendTarget(spec, workspace);
        view = { ...base, kind: "backend", backend: spec.kind, detail: backendDetail(target) };
      } else throw new Error("Unsupported app view. Supported views: web, terminal, display, requests, data and logs.");
      app.views.push(view);
      const stored = restore?.notes?.[view.id];
      const notes = view.kind === "web" && Array.isArray(stored) ? stored.filter(isNote).slice(-MAX_NOTES) : [];
      entries.push({ app, view, target, workspace, revision: 0, source, ...(notes.length ? { notes } : {}) });
    }
    // Commit all views together: a bad later view cannot leave a partial app.
    this.apps.set(app.id, app);
    for (const entry of entries) this.views.set(entry.view.id, entry);
    this.persisted.set(app.id, { sessionId, workspace, manifest: structuredClone(input), id: app.id, viewIds: app.views.map((v) => v.id), createdAt: app.createdAt, ...(app.reviewMode ? { reviewMode: app.reviewMode } : {}), ...(app.agentNotes ? { agentNotes: true } : {}) });
    this.persistNotes(app.id);
    if (!restore) { this.save(); this.emit("published", app.id); }
    return structuredClone(app);
  }

  list(sessionId?: string): SessionApp[] {
    return structuredClone([...this.apps.values()].filter((app) => sessionId === undefined || app.sessionId === sessionId));
  }
  getView(id: string): RegisteredView | undefined { return this.views.get(id); }
  /** An agent turn changed files: re-take changed static snapshots and bump
   * every affected web view (emits `revision`). Returns the bumped view IDs. */
  touch(sessionId: string): string[] {
    const bumped: string[] = [];
    let total = [...this.views.values()].reduce((sum, item) => sum + (item.target.kind === "static" ? item.target.bytes : 0), 0);
    for (const entry of this.views.values()) {
      // A display streams live pixels: only one that restarts on changes has a new revision.
      if (entry.app.sessionId !== sessionId || entry.view.kind !== "web" || (entry.target.kind === "display" && !entry.target.restartOnChange)) continue;
      if (entry.target.kind === "static") {
        if (!entry.source) continue;
        let next: StaticTarget;
        // A broken build keeps the last good snapshot rather than blanking the preview.
        try { next = snapshot(entry.source.workspace, entry.source.directory); } catch { continue; }
        if (sameFiles(entry.target.files, next.files) || total - entry.target.bytes + next.bytes > MAX_TOTAL_BYTES) continue;
        total += next.bytes - entry.target.bytes;
        entry.target = next;
      }
      entry.revision++;
      bumped.push(entry.view.id);
      this.emit("revision", entry.view.id);
    }
    return bumped;
  }
  /** Ports a session already previews, and ports no app may claim. */
  claimedPorts(sessionId: string): Set<number> {
    const ports = new Set(this.reservedPorts);
    for (const { app, target } of this.views.values()) if (app.sessionId === sessionId && target.kind === "service") ports.add(target.port);
    return ports;
  }
  require(sessionId: string, id: string): SessionApp {
    const app = this.apps.get(id);
    if (!app || app.sessionId !== sessionId) throw new Error("App not found in this session. Republish after a machine restart.");
    return app;
  }
  requireView(sessionId: string, appId: string, viewId: string): RegisteredView {
    this.require(sessionId, appId);
    const view = this.views.get(viewId);
    if (!view || view.app.id !== appId) throw new Error("View not found in this app.");
    return view;
  }
  /** Review cards for this app: remembered across sessions' restarts. */
  setReviewMode(sessionId: string, id: string, mode: ReviewCardMode): void {
    if (!REVIEW_CARD_MODES.includes(mode)) throw new Error("Preview cards are ready, every or off.");
    const app = this.require(sessionId, id);
    app.reviewMode = mode;
    const record = this.persisted.get(id);
    if (record) record.reviewMode = mode;
    this.save();
  }
  reviewMode(id: string): ReviewCardMode { return this.apps.get(id)?.reviewMode ?? "ready"; }
  /** Whether agents may read this app's reviewer notes. Only the owner's app sets it. */
  setAgentNotes(sessionId: string, id: string, enabled: boolean): void {
    const app = this.require(sessionId, id);
    if (enabled) app.agentNotes = true; else delete app.agentNotes;
    const record = this.persisted.get(id);
    if (record) { if (enabled) record.agentNotes = true; else delete record.agentNotes; }
    this.save();
  }
  agentNotes(id: string): boolean { return this.apps.get(id)?.agentNotes === true; }
  /** Includes persisted apps not restored yet; unread pictures survive GC. */
  notePictureHashes(): string[] {
    return [...this.persisted.values()].flatMap(record => Object.values(record.notes ?? {}).flatMap(notes => Array.isArray(notes) ? notes.filter(isNote).flatMap(note => note.shot ? [note.shot.hash] : []) : []));
  }
  /** A reviewer's note: kept bounded, saved with the app, announced (`notes`). */
  addNote(viewId: string, note: ReviewerNote): void {
    const entry = this.views.get(viewId);
    if (!entry || entry.view.kind !== "web") return;
    entry.notes = [...(entry.notes ?? []), note].slice(-MAX_NOTES);
    this.persistNotes(entry.app.id);
    this.save();
    this.emit("notes", viewId);
  }
  clearNotes(viewId: string): void {
    const entry = this.views.get(viewId);
    if (!entry?.notes) return;
    delete entry.notes;
    this.persistNotes(entry.app.id);
    this.save();
  }
  private persistNotes(appId: string): void {
    const record = this.persisted.get(appId);
    const app = this.apps.get(appId);
    if (!record || !app) return;
    const notes = Object.fromEntries(app.views.map((view) => [view.id, this.views.get(view.id)?.notes]).filter(([, list]) => Array.isArray(list) && list.length));
    if (Object.keys(notes).length) record.notes = notes; else delete record.notes;
  }
  remove(sessionId: string, id: string): void {
    const app = this.require(sessionId, id);
    for (const view of app.views) this.views.delete(view.id);
    this.apps.delete(id);
    this.persisted.delete(id);
    this.save();
  }
}
