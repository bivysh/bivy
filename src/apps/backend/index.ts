// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { AppRegistry, BackendTarget, RegisteredView } from "../registry.js";
import type { DataQuery, DataViewResult, EvidenceRow, LogsViewResult, RequestAnswer, RequestDetail, RequestItem, RequestsViewResult } from "../types.js";
import { parseHttpFile, resolveRequest, type HttpRequestSpec } from "./http-file.js";
import { answerChanged, answerChanges, rowChanges } from "./compare.js";
import { parseRows, readQueryFile, type Rows } from "./rows.js";
import { LogBuffer, LogMarks } from "./logs.js";
import { redactSecrets } from "../../redact.js";

/** Backend views: what a backend change did, seen the way a UI change is.
 *  Requests are the API as buttons (`.http` files), Data is the rows saved
 *  queries return, Logs is a server's output with a marker at each action.
 *  Before each agent run, the safe requests and every query run once; after
 *  it, again; what changed becomes the run's evidence (see `evidence`). */
export interface BackendTerminals {
  start(input: { command: string; args: string[]; workspace: string; name: string }): Promise<string>;
  has(termId: string): boolean;
  /** Follows a terminal's output as it arrives. Without it, logs stay empty. */
  tap?(termId: string, onData: (data: string) => void): (() => void) | undefined;
}
type Entry = RegisteredView & { target: BackendTarget };
interface LoadedRequest { id: string; file: string; spec: HttpRequestSpec; variables: Record<string, string> }

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_BODY = 1024 * 1024;
const QUERY_TIMEOUT_MS = 15_000;
const MAX_OUTPUT = 4 * 1024 * 1024;
const MAX_FILES = 50;
const MAX_FILE_BYTES = 256 * 1024;
const SHOWN_ROWS = 200;
const SAFE = ["GET", "HEAD"];
const LOOPBACK = ["127.0.0.1", "localhost", "[::1]", "::1"];

/** Files of one kind in a backend view's folder, read fresh (an agent may have just written one). */
function files(dir: string, extension: string): { file: string; text?: string; error?: string }[] {
  let names: string[];
  try { names = fs.readdirSync(dir).filter((name) => name.endsWith(extension)).sort().slice(0, MAX_FILES); } catch { return []; }
  return names.map((name) => {
    const file = path.join(dir, name);
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile()) return { file: name, error: "Not a regular file." };
      if (stat.size > MAX_FILE_BYTES) return { file: name, error: "Larger than 256 KiB." };
      return { file: name, text: fs.readFileSync(file, "utf8") };
    } catch (error) { return { file: name, error: (error as Error).message }; }
  });
}

export class Backend {
  private logs = new Map<string, LogBuffer>();
  readonly marks = new LogMarks();
  private taps = new Map<string, () => void>();
  /** A logs view's own command: its terminal, once started. */
  private sources = new Map<string, Promise<string>>();
  private answers = new Map<string, Map<string, { last?: RequestAnswer; before?: RequestAnswer }>>();
  private results = new Map<string, Map<string, { last?: Rows & { at: number }; before?: Rows; error?: string }>>();
  /** When the current agent run began, per session (logs count errors since). */
  private runs = new Map<string, number>();

  constructor(private readonly registry: AppRegistry, private readonly terminals: BackendTerminals) {
    // What happens in the preview (a page, a form) marks the logs: the gateway says.
    registry.on("action", (viewId: string, label: string) => {
      const entry = this.registry.getView(viewId);
      if (entry) this.marks.add(entry.app.id, label);
    });
  }

  views(sessionId: string): Entry[] {
    return this.registry.list(sessionId).flatMap((app) => app.views.filter((view) => view.kind === "backend").map((view) => this.registry.getView(view.id) as Entry)).filter(Boolean);
  }
  /** A backend view of a kind by app or view ID or name (`bivy app requests`); by default the first. */
  pick(sessionId: string, kind: BackendTarget["kind"], target?: string): Entry {
    const views = this.views(sessionId).filter((entry) => entry.target.kind === kind);
    if (!views.length) throw new Error(`This session has no ${kind} view. Add {"kind":"${kind}","name":"…"} to the app's manifest and publish it again.`);
    if (!target) return views[0]!;
    const wanted = target.trim().toLowerCase();
    const found = views.find((entry) => [entry.view.id, entry.app.id].includes(wanted) || entry.view.name.toLowerCase() === wanted || entry.app.name.toLowerCase() === wanted);
    if (!found) throw new Error(`No ${kind} view called "${target}". Run bivy app list to see them.`);
    return found;
  }

  // Logs ---------------------------------------------------------------------

  /** A server Bivy runs has started: follow its output. Every managed server is
   *  followed, so its logs reach back before anyone opened them. */
  attach(viewId: string, termId: string): void {
    this.taps.get(viewId)?.();
    const buffer = this.buffer(viewId);
    const stop = this.terminals.tap?.(termId, (data) => buffer.append(data));
    if (stop) this.taps.set(viewId, stop);
  }
  private buffer(key: string): LogBuffer {
    let buffer = this.logs.get(key);
    if (!buffer) { buffer = new LogBuffer(); this.logs.set(key, buffer); }
    return buffer;
  }
  /** Where a logs view reads: a view of its app that Bivy runs, or its own command. */
  private logSource(entry: Entry & { target: { kind: "logs" } }): { key: string; detail: string; command?: { command: string; args: string[]; workspace: string } } {
    const source = entry.target.source;
    if ("command" in source) return { key: entry.view.id, detail: entry.view.kind === "backend" ? entry.view.detail : "", command: source };
    const servers = entry.app.views.map((view) => this.registry.getView(view.id)!).filter((view) => view && ((view.target.kind === "service" && view.target.start) || view.target.kind === "display"));
    const server = source.view ? servers.find((view) => view.view.name.toLowerCase() === source.view!.toLowerCase()) : servers[0];
    if (!server) throw new Error(source.view ? `${entry.app.name} has no view called "${source.view}" that Bivy runs.` : `${entry.app.name} has no server that Bivy runs. Give the logs view a "source": a file or a command.`);
    return { key: server.view.id, detail: `${server.view.name} output` };
  }
  async log(entry: Entry, since = 0): Promise<LogsViewResult> {
    if (entry.target.kind !== "logs") throw new Error("Not a logs view.");
    const source = this.logSource(entry as Entry & { target: { kind: "logs" } });
    let running = this.taps.has(source.key);
    if (source.command) {
      // Started on first look and kept running, so the next look has what happened in between.
      let started = this.sources.get(entry.view.id);
      if (started && !this.terminals.has(await started.catch(() => ""))) { this.sources.delete(entry.view.id); started = undefined; }
      if (!started) {
        started = this.terminals.start({ ...source.command, name: `${entry.app.name} · ${entry.view.name}` });
        this.sources.set(entry.view.id, started);
        this.attach(source.key, await started);
      }
      running = this.terminals.has(await started);
    }
    return { detail: source.detail, lines: this.buffer(source.key).read(since), marks: this.marks.read(entry.app.id), running };
  }

  // Requests -------------------------------------------------------------------

  /** The address `{{base}}` stands for: the view's own, or a web server of its app. */
  private base(entry: Entry & { target: { kind: "requests" } }): string {
    const base = entry.target.base;
    if (base && "url" in base) return base.url;
    const services = entry.app.views.map((view) => this.registry.getView(view.id)!).filter((view) => view?.target.kind === "service");
    const service = base ? services.find((view) => view.view.name.toLowerCase() === base.view.toLowerCase()) : services[0];
    return service && service.target.kind === "service" ? `http://127.0.0.1:${service.target.port}` : "";
  }
  private requestsOf(entry: Entry): { requests: LoadedRequest[]; problems: { file: string; error: string }[] } {
    if (entry.target.kind !== "requests") throw new Error("Not a requests view.");
    const requests: LoadedRequest[] = [], problems: { file: string; error: string }[] = [];
    for (const file of files(entry.target.dir, ".http")) {
      if (file.error !== undefined) { problems.push({ file: file.file, error: file.error }); continue; }
      const parsed = parseHttpFile(file.text!);
      if (!parsed.requests.length) problems.push({ file: file.file, error: "No requests in it. A request is a line like \"GET {{base}}/orders\"." });
      const seen = new Map<string, number>();
      for (const spec of parsed.requests) {
        // Stable while the file keeps its order: its file and its name.
        const slug = spec.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "request";
        const n = (seen.get(slug) ?? 0) + 1; seen.set(slug, n);
        requests.push({ id: `${file.file.replace(/\.http$/, "")}/${slug}${n > 1 ? `-${n}` : ""}`, file: file.file, spec, variables: parsed.variables });
      }
    }
    return { requests, problems };
  }
  /** By ID, or by name for people and agents typing it. */
  private findRequest(entry: Entry, id: string): LoadedRequest {
    const { requests } = this.requestsOf(entry);
    const found = requests.find((item) => item.id === id) ?? requests.find((item) => item.spec.name.toLowerCase() === id.trim().toLowerCase());
    if (!found) throw new Error(`No request "${id}"${requests.length ? `. Its requests: ${requests.map((item) => item.spec.name).join(", ")}` : ""}.`);
    return found;
  }
  private item(entry: Entry, request: LoadedRequest, base: string): RequestItem {
    const resolved = resolveRequest(request.spec, request.variables, { base });
    let host: string | undefined;
    try { host = new URL(resolved.url).host; } catch { /* a path, or unresolved */ }
    const own = base ? new URL(base).host : undefined;
    const external = host && host !== own && !LOOPBACK.includes(host.replace(/:\d+$/, "")) ? host : undefined;
    const kept = this.answers.get(entry.view.id)?.get(request.id);
    return {
      id: request.id, file: request.file, name: request.spec.name, method: request.spec.method, url: resolved.url,
      auto: request.spec.auto || (SAFE.includes(request.spec.method) && !external),
      ...(external ? { external } : {}), ...(kept?.last ? { last: kept.last } : {}), ...(kept?.before ? { before: kept.before } : {}),
    };
  }
  requests(entry: Entry): RequestsViewResult {
    const base = this.base(entry as Entry & { target: { kind: "requests" } });
    const { requests, problems } = this.requestsOf(entry);
    return { base, requests: requests.map((request) => this.item(entry, request, base)), problems };
  }
  detail(entry: Entry, id: string): RequestDetail {
    const base = this.base(entry as Entry & { target: { kind: "requests" } });
    const request = this.findRequest(entry, id);
    const item = this.item(entry, request, base);
    return { item, request: resolveRequest(request.spec, request.variables, { base }), ...(item.before && item.last ? { changes: answerChanges(item.before, item.last) } : {}) };
  }
  /** Runs one request now, from this machine. `as`: keep it as the run's "before". */
  async run(entry: Entry, id: string, as: "last" | "before" = "last"): Promise<RequestDetail> {
    const base = this.base(entry as Entry & { target: { kind: "requests" } });
    const request = this.findRequest(entry, id);
    const resolved = resolveRequest(request.spec, request.variables, { base });
    if (as === "last") this.marks.add(entry.app.id, `Ran “${request.spec.name}”`);
    const answer = await send(resolved);
    let kept = this.answers.get(entry.view.id);
    if (!kept) { kept = new Map(); this.answers.set(entry.view.id, kept); }
    kept.set(request.id, as === "before" ? { before: answer, last: answer } : { ...kept.get(request.id), last: answer });
    return this.detail(entry, request.id);
  }
  /** Every request that runs on its own (GET/HEAD to the app's server, or @auto). */
  async runAuto(entry: Entry, as: "last" | "before" = "last"): Promise<RequestsViewResult> {
    for (const item of this.requests(entry).requests.filter((request) => request.auto)) await this.run(entry, item.id, as).catch(() => {});
    return this.requests(entry);
  }

  // Data -----------------------------------------------------------------------

  private queriesOf(entry: Entry): { queries: { id: string; file: string; sql: string; title?: string; key?: string }[]; problems: { file: string; error: string }[] } {
    if (entry.target.kind !== "data") throw new Error("Not a data view.");
    const queries: { id: string; file: string; sql: string; title?: string; key?: string }[] = [], problems: { file: string; error: string }[] = [];
    for (const file of files(entry.target.dir, ".sql")) {
      if (file.error !== undefined) problems.push({ file: file.file, error: file.error });
      else queries.push({ id: file.file.replace(/\.sql$/, ""), file: file.file, ...readQueryFile(file.text!) });
    }
    return { queries, problems };
  }
  /** Runs a query through the view's client: the query on stdin, rows on stdout. */
  private query(entry: Entry, sql: string): Promise<Rows> {
    const target = entry.target as Extract<BackendTarget, { kind: "data" }>;
    return new Promise((resolve, reject) => {
      const child = spawn(target.command, target.args, { cwd: target.workspace, stdio: ["pipe", "pipe", "pipe"] });
      let out = "", err = "";
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`The query took longer than ${QUERY_TIMEOUT_MS / 1000} seconds.`)); }, QUERY_TIMEOUT_MS);
      child.stdout.on("data", (chunk: Buffer) => { out += chunk; if (out.length > MAX_OUTPUT) child.kill("SIGKILL"); });
      child.stderr.on("data", (chunk: Buffer) => { err = (err + chunk).slice(-4000); });
      child.on("error", (error) => { clearTimeout(timer); reject(new Error((error as NodeJS.ErrnoException).code === "ENOENT" ? `"${target.command}" isn't installed on this machine.` : error.message)); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) reject(new Error(redactSecrets(err.trim()) || `${target.command} exited with ${code}.`));
        else resolve(parseRows(out));
      });
      child.stdin.on("error", () => {});
      child.stdin.end(sql.endsWith(";") || /;\s*$/.test(sql) ? `${sql}\n` : `${sql};\n`);
    });
  }
  /** Each saved query's rows and, once a run has begun, what changed since. `run`: query now. */
  async data(entry: Entry, run = false, as: "last" | "before" = "last"): Promise<DataViewResult> {
    const { queries, problems } = this.queriesOf(entry);
    let kept = this.results.get(entry.view.id);
    if (!kept) { kept = new Map(); this.results.set(entry.view.id, kept); }
    const store = kept;
    if (run || queries.some((query) => !store.get(query.id)?.last && !store.get(query.id)?.error)) {
      for (const query of queries) {
        if (!run && (store.get(query.id)?.last || store.get(query.id)?.error)) continue;
        try {
          const rows = await this.query(entry, query.sql);
          store.set(query.id, as === "before" ? { before: rows, last: { ...rows, at: Date.now() } } : { ...store.get(query.id), last: { ...rows, at: Date.now() }, error: undefined });
        } catch (error) { store.set(query.id, { ...store.get(query.id), error: (error as Error).message }); }
      }
    }
    return {
      detail: entry.view.kind === "backend" ? entry.view.detail : "", problems,
      queries: queries.map((query): DataQuery => {
        const kept = store.get(query.id);
        const columns = kept?.last?.columns ?? [];
        const key = query.key ?? (columns.includes("id") ? "id" : columns[0] ?? "id");
        return {
          id: query.id, file: query.file, title: query.title ?? query.id, key, columns,
          rows: kept?.last?.rows.slice(0, SHOWN_ROWS) ?? [], count: kept?.last?.rows.length ?? 0,
          ...(kept?.last ? { at: kept.last.at } : {}), ...(kept?.error ? { error: kept.error } : {}),
          ...(kept?.before && kept.last ? { changes: rowChanges(kept.before.rows, kept.last.rows, key) } : {}),
        };
      }),
    };
  }

  // A run's evidence -----------------------------------------------------------

  /** Before an agent run: the safe requests and every query, as "before". */
  async baseline(sessionId: string): Promise<void> {
    this.runs.set(sessionId, Date.now());
    for (const app of this.registry.list(sessionId)) if (app.views.some((view) => view.kind === "backend")) this.marks.add(app.id, "The agent started working");
    for (const entry of this.views(sessionId)) {
      if (entry.target.kind === "requests") await this.runAuto(entry, "before").catch(() => {});
      if (entry.target.kind === "data") await this.data(entry, true, "before").catch(() => {});
    }
  }
  /** After it: the same again, and one line per thing that changed, per app. */
  async evidence(sessionId: string): Promise<Map<string, { rows: EvidenceRow[]; changed: boolean }>> {
    const since = this.runs.get(sessionId) ?? Date.now();
    const out = new Map<string, { rows: EvidenceRow[]; changed: boolean }>();
    const add = (entry: Entry, rows: Omit<EvidenceRow, "viewId" | "view" | "backend">[]) => {
      const kept = out.get(entry.app.id) ?? { rows: [], changed: false };
      for (const row of rows) kept.rows.push({ viewId: entry.view.id, view: entry.view.name, backend: entry.target.kind, ...row });
      kept.changed ||= rows.some((row) => row.tone === "warn" || row.tone === "danger");
      out.set(entry.app.id, kept);
    };
    for (const entry of this.views(sessionId)) {
      try {
        if (entry.target.kind === "requests") {
          const items = (await this.runAuto(entry)).requests.filter((item) => item.auto && item.before && item.last);
          const changed = items.filter((item) => answerChanged(item.before!, item.last!));
          add(entry, [
            ...changed.slice(0, 3).map((item) => ({
              summary: `${item.method} ${item.name}`, item: item.id,
              detail: item.before!.status !== item.last!.status ? `${item.before!.status || "no answer"} → ${item.last!.status || "no answer"}` : "answer changed",
              tone: (item.last!.error || item.last!.status >= 500 ? "danger" : "warn") as EvidenceRow["tone"],
            })),
            ...(changed.length > 3 ? [{ summary: `${changed.length - 3} more answer differently`, tone: "warn" as const }] : []),
            ...(items.length > changed.length ? [{ summary: `${items.length - changed.length} ${items.length - changed.length === 1 ? "request answers" : "requests answer"} the same`, tone: (changed.length ? "neutral" : "ok") as EvidenceRow["tone"] }] : []),
          ]);
        } else if (entry.target.kind === "data") {
          const queries = (await this.data(entry, true)).queries;
          const changed = queries.filter((query) => query.changes && (query.changes.added.length || query.changes.changed.length || query.changes.removed.length));
          add(entry, changed.length ? changed.slice(0, 4).map((query) => ({
            summary: query.title, item: query.id, tone: "warn" as const,
            detail: [query.changes!.added.length && `+${query.changes!.added.length}`, query.changes!.changed.length && `~${query.changes!.changed.length}`, query.changes!.removed.length && `−${query.changes!.removed.length}`].filter(Boolean).join(" "),
          })) : queries.some((query) => query.changes) ? [{ summary: "No rows changed", tone: "ok" }] : []);
        } else {
          const log = await this.log(entry, since);
          const errors = log.lines.filter((line) => line.level === "error");
          add(entry, [errors.length
            ? { summary: `${errors.length} new ${errors.length === 1 ? "error" : "errors"}`, detail: errors[0]!.text.slice(0, 160), tone: "danger" }
            : { summary: "No new errors", tone: "ok" }]);
        }
      } catch { /* a view that can't answer adds nothing to the card */ }
    }
    return out;
  }
  /** An app was removed: stop following its sources and forget its results. */
  forget(viewIds: string[], appId: string): void {
    for (const id of viewIds) {
      this.taps.get(id)?.(); this.taps.delete(id);
      this.logs.delete(id); this.answers.delete(id); this.results.delete(id); this.sources.delete(id);
    }
    this.marks.forget(appId);
  }
}

/** One request, from this machine. Redirects are shown, not followed: a 302 is an answer. */
async function send(request: { method: string; url: string; headers: [string, string][]; body: string }): Promise<RequestAnswer> {
  const at = Date.now();
  let url: URL;
  try { url = new URL(request.url); } catch { return { status: 0, statusText: "", ms: 0, at, headers: {}, body: "", error: `“${request.url}” isn't an address. Use {{base}}/path, or a full http(s) URL.` }; }
  if (!["http:", "https:"].includes(url.protocol)) return { status: 0, statusText: "", ms: 0, at, headers: {}, body: "", error: "Only http and https requests run." };
  try {
    const response = await fetch(url, { method: request.method, headers: request.headers, body: SAFE.includes(request.method) || !request.body ? undefined : request.body, redirect: "manual", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = []; let size = 0, truncated = false;
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length; chunks.push(value);
      if (size > MAX_BODY) { truncated = true; await reader.cancel(); break; }
    }
    const body = Buffer.concat(chunks).subarray(0, MAX_BODY).toString("utf8");
    const type = response.headers.get("content-type") ?? "";
    const headers = Object.fromEntries([...response.headers].slice(0, 30));
    return { status: response.status, statusText: response.statusText, ms: Date.now() - at, at, headers, body, ...(/json/i.test(type) ? { json: true } : {}), ...(truncated ? { truncated: true } : {}) };
  } catch (error) {
    const reason = (error as Error).name === "TimeoutError" ? `No answer within ${REQUEST_TIMEOUT_MS / 1000} seconds.` : ((error as { cause?: { code?: string } }).cause?.code === "ECONNREFUSED" ? `Nothing is answering at ${url.host}.` : (error as Error).message);
    return { status: 0, statusText: "", ms: Date.now() - at, at, headers: {}, body: "", error: reason };
  }
}
