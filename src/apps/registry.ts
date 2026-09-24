// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { AppManifest, AppView, SessionApp } from "./types.js";

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_FILES = 2000;
export type AppTarget = { kind: "static"; files: Map<string, Buffer>; bytes: number } | { kind: "service"; port: number } | { kind: "terminal"; command: string; args: string[]; workspace: string };
export interface RegisteredView { app: SessionApp; view: AppView; target: AppTarget }

/** Snapshot, not a live filesystem server: symlinks and hidden files are never published. */
function snapshot(workspace: string, directory: string): AppTarget {
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

/** Deliberately ephemeral: restart invalidates apps rather than trusting reused local ports. */
export class AppRegistry {
  private apps = new Map<string, SessionApp>();
  private views = new Map<string, RegisteredView>();
  constructor(private readonly reservedPorts: number[] = []) {}

  publish(sessionId: string, workspace: string, input: AppManifest): SessionApp {
    const name = (value: unknown): string => {
      if (typeof value !== "string" || !value.trim() || value.length > 100) throw new Error("App and view names must contain 1–100 characters.");
      return value.trim();
    };
    if (!input || input.version !== 1 || !Array.isArray(input.views) || !input.views.length || input.views.length > 8) throw new Error("Expected manifest version 1 with 1–8 views.");
    if (this.apps.size >= 50) throw new Error("Remove an app before publishing more (limit: 50).");
    const app: SessionApp = { id: randomBytes(16).toString("hex"), sessionId, name: name(input.name), views: [], createdAt: Date.now() };
    const entries: RegisteredView[] = [];
    let total = [...this.views.values()].reduce((sum, item) => sum + (item.target.kind === "static" ? item.target.bytes : 0), 0);
    for (const spec of input.views) {
      const base = { id: randomBytes(16).toString("hex"), name: name(spec?.name) };
      let target: AppTarget;
      let view: AppView;
      if (spec.kind === "web" && spec.source?.kind === "service") {
        const port = spec.source.port;
        if (!Number.isInteger(port) || port < 1024 || port > 65535 || this.reservedPorts.includes(port)) throw new Error("Choose a non-reserved local service port between 1024 and 65535.");
        target = { kind: "service", port };
        view = { ...base, kind: "web", source: "service" };
      } else if (spec.kind === "web" && spec.source?.kind === "static") {
        if (typeof spec.source.directory !== "string" || !spec.source.directory) throw new Error("Static directory is required.");
        target = snapshot(workspace, spec.source.directory);
        if (target.kind === "static") total += target.bytes;
        if (total > MAX_TOTAL_BYTES) throw new Error("Static apps exceed the node's 100 MiB snapshot budget.");
        view = { ...base, kind: "web", source: "static" };
      } else if (spec.kind === "terminal") {
        if (typeof spec.command !== "string" || !spec.command.trim() || spec.command.length > 1000 || spec.command.includes("\u0000")) throw new Error("Terminal view requires an executable command.");
        if (spec.args !== undefined && (!Array.isArray(spec.args) || spec.args.length > 100 || spec.args.some((arg) => typeof arg !== "string" || arg.length > 4000 || arg.includes("\u0000")))) throw new Error("Invalid terminal arguments.");
        const args = [...(spec.args ?? [])];
        target = { kind: "terminal", command: spec.command, args, workspace: fs.realpathSync(workspace) };
        view = { ...base, kind: "terminal", command: spec.command, args };
      } else throw new Error("Unsupported app view. This machine supports web and terminal views.");
      app.views.push(view);
      entries.push({ app, view, target });
    }
    // Commit all views together: a bad later view cannot leave a partial app.
    this.apps.set(app.id, app);
    for (const entry of entries) this.views.set(entry.view.id, entry);
    return structuredClone(app);
  }

  list(sessionId: string): SessionApp[] {
    return structuredClone([...this.apps.values()].filter((app) => app.sessionId === sessionId));
  }
  getView(id: string): RegisteredView | undefined { return this.views.get(id); }
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
  }
}
