// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import type { AppManifest, AppView, DisplayStats, ReviewerNote, SessionApp } from "./types.js";

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_FILES = 2000;
type StaticTarget = { kind: "static"; files: Map<string, Buffer>; bytes: number };
type Command = { command: string; args: string[]; workspace: string };
export type AppTarget = StaticTarget | { kind: "service"; port: number; start?: Command } | ({ kind: "terminal" } & Command) | ({ kind: "display"; restartOnChange: boolean } & Command);
/** What survives a node restart: the manifest and the IDs chat links point at. */
interface Persisted { sessionId: string; workspace: string; manifest: AppManifest; id: string; viewIds: string[]; createdAt: number }
export interface RegisteredView {
  app: SessionApp; view: AppView; target: AppTarget;
  /** Bumped when an agent turn changes files, so open previews reload. */
  revision: number;
  /** Last page the preview shell framed; a reload returns there, not to `/`. */
  lastPath?: string;
  /** Reviewer notes from shared links, newest last, capped. */
  notes?: ReviewerNote[];
  /** Recent screenshots for Compare, newest last (agent screenshots on only). */
  shots?: { revision: number; at: number; png: Buffer }[];
  /** Where a static snapshot came from, so a turn can re-take it. */
  source?: { workspace: string; directory: string };
  /** A running display view's private VNC socket; the gateway streams it. */
  display?: string;
  /** Device pixels per CSS pixel its display runs at (set when it starts). */
  displayScale?: number;
  /** The last viewer's stream measurements. */
  stats?: DisplayStats;
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
export class AppRegistry extends EventEmitter {
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
        this.publish(record.sessionId, record.workspace, { ...record.manifest, views: keep.map((k) => k.spec) }, { id: record.id, viewIds: keep.map((k) => k.id!), createdAt: record.createdAt });
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

  publish(sessionId: string, workspace: string, input: AppManifest, restore?: { id: string; viewIds: string[]; createdAt: number }): SessionApp {
    const name = (value: unknown): string => {
      if (typeof value !== "string" || !value.trim() || value.length > 100) throw new Error("App and view names must contain 1–100 characters.");
      return value.trim();
    };
    if (!input || input.version !== 1 || !Array.isArray(input.views) || !input.views.length || input.views.length > 8) throw new Error("Expected manifest version 1 with 1–8 views.");
    if (this.apps.size >= 50) throw new Error("Remove an app before publishing more (limit: 50).");
    const id = (i?: number) => (i === undefined ? restore?.id : restore?.viewIds[i]) ?? randomBytes(16).toString("hex");
    const app: SessionApp = { id: id(), sessionId, name: name(input.name), views: [], createdAt: restore?.createdAt ?? Date.now() };
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
      } else throw new Error("Unsupported app view. Supported views: web, terminal and display.");
      app.views.push(view);
      entries.push({ app, view, target, revision: 0, source });
    }
    // Commit all views together: a bad later view cannot leave a partial app.
    this.apps.set(app.id, app);
    for (const entry of entries) this.views.set(entry.view.id, entry);
    this.persisted.set(app.id, { sessionId, workspace, manifest: structuredClone(input), id: app.id, viewIds: app.views.map((v) => v.id), createdAt: app.createdAt });
    if (!restore) this.save();
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
  remove(sessionId: string, id: string): void {
    const app = this.require(sessionId, id);
    for (const view of app.views) this.views.delete(view.id);
    this.apps.delete(id);
    this.persisted.delete(id);
    this.save();
  }
}
