// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AppView, DataQuery, DataRowChange, DataViewResult, LogLine, LogMark, LogsViewResult, RequestAnswer, RequestDetail, RequestItem, RequestsViewResult, SessionApp, ValueChange } from "@bivy/core";
import { controller } from "../store/useStore.js";
import { Panel } from "./Panel.js";
import { Spinner } from "./Spinner.js";
import { ConfirmDialog } from "./AppDialog.js";
import { relTime } from "./SessionList.js";

type BackendAppView = AppView & { kind: "backend" };
type Ask = <T>(command: "apps.requests" | "apps.request" | "apps.runRequest" | "apps.data" | "apps.serverLog", fields?: Record<string, unknown>) => Promise<T>;

/**
 * Backend views: what a backend change did, seen the way a UI change is.
 * Requests (the API as buttons), Data (rows saved queries return) and Logs (a
 * server's output, with a marker at each action). Each compares now with how
 * it was when the agent's last run began. Everything shown is the app's own
 * output: text, never run here.
 */
export function BackendView({ sessionId, nodeId, app, view, item, docked, online, onBack, onClose, onDraft }: {
  sessionId: string; nodeId?: string | null; app: SessionApp; view: BackendAppView; item?: string; docked?: boolean; online: boolean;
  onBack: () => void; onClose: () => void; onDraft: (text: string) => void;
}) {
  const ask: Ask = async (command, fields = {}) => await controller.appCommand(command, sessionId, { appId: app.id, viewId: view.id, ...fields }, nodeId) as unknown as never;
  const Pane = PANES[view.backend];
  // One back button: a pane deeper than its list (a request's answer) takes it over.
  const [inner, setInner] = useState<{ label: string; back: () => void } | null>(null);
  return <Panel docked={docked} title={view.name} ariaLabel={`${app.name}: ${view.name}`} onClose={onClose} autoFocusSearch={false} size="large">
    <div className="backend-view">
      <div className="backend-toolbar"><button className="btn sm ghost backend-back" onClick={inner ? inner.back : onBack}>‹ {inner ? inner.label : "Apps"}</button><span className="backend-source">{app.name} · {view.detail}</span></div>
      <Pane ask={ask} item={item} online={online} onDraft={onDraft} app={app} setBack={setInner} />
    </div>
  </Panel>;
}
type PaneProps = { ask: Ask; item?: string; online: boolean; onDraft: (text: string) => void; app: SessionApp; setBack: (back: { label: string; back: () => void } | null) => void };
/** One pane per kind of backend view: adding a kind is adding a row. */
const PANES: Record<BackendAppView["backend"], (props: PaneProps) => ReactNode> = { requests: RequestsPane, data: DataPane, logs: LogsPane };

/** "just now", "5m ago". */
const ago = (at: number) => { const when = relTime(at); return when === "now" ? "just now" : `${when} ago`; };
const errorText = (e: unknown, fallback: string) => e instanceof Error ? e.message : fallback;
const statusTone = (answer?: RequestAnswer) => !answer ? undefined : answer.error || answer.status >= 500 ? "danger" : answer.status >= 400 ? "warn" : "ok";
const statusText = (answer: RequestAnswer) => answer.error ? "No answer" : String(answer.status);

/** Before · Now · Changes, as on review cards. Options that have nothing to show are disabled. */
function Switch<T extends string>({ value, options, onChange, label }: { value: T; options: { id: T; label: string; disabled?: boolean }[]; onChange: (id: T) => void; label: string }) {
  return <div className="segmented backend-switch" role="radiogroup" aria-label={label}>
    {options.map((option) => <button key={option.id} type="button" role="radio" className="seg-btn" aria-checked={value === option.id} disabled={option.disabled} onClick={() => onChange(option.id)}>{option.label}</button>)}
  </div>;
}
function Changes({ changes, empty }: { changes: ValueChange[]; empty: string }) {
  if (!changes.length) return <p className="backend-empty">{empty}</p>;
  return <ul className="backend-changes">{changes.map((change) => <li key={change.path}>
    <span className="backend-path">{change.path}</span>
    {change.before !== undefined && <span className="backend-was"><span className="sr-only">was </span>{change.before}</span>}
    {change.after !== undefined ? <span className="backend-now"><span className="sr-only">now </span>{change.after}</span> : <span className="backend-gone">removed</span>}
  </li>)}</ul>;
}
function body(answer: RequestAnswer): string {
  if (answer.error) return answer.error;
  if (answer.json) { try { return JSON.stringify(JSON.parse(answer.body), null, 2); } catch { /* as sent */ } }
  return answer.body || "(empty body)";
}

// Requests ---------------------------------------------------------------------

function RequestsPane({ ask, item: initial, online, onDraft, setBack }: PaneProps) {
  const [result, setResult] = useState<RequestsViewResult | null>(null);
  const [open, setOpen] = useState<string | undefined>(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const load = () => ask<RequestsViewResult>("apps.requests").then(setResult, (e: unknown) => setError(errorText(e, "Could not read the requests.")));
  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setBack(open ? { label: "Requests", back: () => { setOpen(undefined); void load(); } } : null);
    return () => setBack(null);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const runAll = async () => {
    setBusy("all"); setError("");
    try { setResult(await ask<RequestsViewResult>("apps.runRequest")); }
    catch (e) { setError(errorText(e, "Could not run the requests.")); }
    finally { setBusy(null); }
  };
  if (open) return <RequestDetailPane ask={ask} id={open} online={online} onDraft={onDraft} />;
  if (!result) return error ? <div className="banner inline" data-tone="danger" role="alert">{error}</div> : <div className="apps-state" role="status"><Spinner size="sm" /><span>Reading requests…</span></div>;
  const files = [...new Set(result.requests.map((request) => request.file))];
  return <>
    <div className="backend-toolbar">
      <span className="backend-meta">{result.base ? <>Against <code>{result.base}</code></> : "No server for {{base}}: give the view a base"}</span>
      <button className="btn sm" disabled={!online || busy !== null || !result.requests.some((request) => request.auto)} onClick={() => void runAll()}>{busy === "all" ? <Spinner size="xs" /> : null}Run all</button>
    </div>
    {error && <div className="banner inline" data-tone="danger" role="alert">{error}</div>}
    {result.problems.map((problem) => <div key={problem.file} className="banner inline" data-tone="warn" role="status"><span className="banner-text"><code>{problem.file}</code> {problem.error}</span></div>)}
    {!result.requests.length && !result.problems.length && <div className="apps-empty">
      <strong>No requests yet</strong>
      <p>Requests are <code>.http</code> files in <code>.bivy/requests</code>, like <code>GET {"{{base}}"}/orders</code>. Ask the agent to add the ones that show what it changed.</p>
    </div>}
    {files.map((file) => <section key={file} className="backend-group" aria-label={file}>
      <h3 className="apps-group-title">{file}</h3>
      <ul className="backend-list">{result.requests.filter((request) => request.file === file).map((request) => <li key={request.id}>
        <button type="button" className="backend-row" onClick={() => setOpen(request.id)}>
          <span className="backend-method" data-method={request.method}>{request.method}</span>
          <span className="backend-row-text"><span className="backend-row-name">{request.name}</span><code className="backend-row-sub">{request.url.replace(result.base, "") || "/"}</code></span>
          {request.external && <span className="badge" data-tone="warn" title="Not this app's server">→ {request.external}</span>}
          <RequestBadge request={request} />
        </button>
      </li>)}</ul>
    </section>)}
    {result.requests.length > 0 && <p className="backend-foot">GET requests to this app, and those marked <code># @auto</code>, run before and after each agent run. Others run only when you tap them.</p>}
  </>;
}
function RequestBadge({ request }: { request: RequestItem }) {
  if (!request.last) return <span className="badge">{request.auto ? "not run yet" : "runs on tap"}</span>;
  const changed = request.before && (request.before.status !== request.last.status || Boolean(request.before.error) !== Boolean(request.last.error));
  return <span className="badge" data-tone={changed ? "warn" : statusTone(request.last)}>{changed ? `${statusText(request.before!)} → ${statusText(request.last)}` : statusText(request.last)}</span>;
}

function RequestDetailPane({ ask, id, online, onDraft }: { ask: Ask; id: string; online: boolean; onDraft: (text: string) => void }) {
  const [detail, setDetail] = useState<RequestDetail | null>(null);
  const [side, setSide] = useState<"before" | "now" | "changes">("now");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    void ask<RequestDetail>("apps.request", { id }).then((found) => { setDetail(found); if (found.changes?.length) setSide("changes"); }, (e: unknown) => setError(errorText(e, "Could not read the request.")));
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  const run = async () => {
    setConfirm(false); setBusy(true); setError("");
    try { const found = await ask<RequestDetail>("apps.runRequest", { id }); setDetail(found); setSide(found.changes?.length ? "changes" : "now"); }
    catch (e) { setError(errorText(e, "Could not run the request.")); }
    finally { setBusy(false); }
  };
  if (!detail) return <>{error ? <div className="banner inline" data-tone="danger" role="alert">{error}</div> : <div className="apps-state" role="status"><Spinner size="sm" /><span>Reading…</span></div>}</>;
  const { item, request } = detail;
  const shown = side === "before" ? item.before : item.last;
  const draft = () => onDraft(`The request “${item.name}” (${item.method} ${item.url}, .bivy/requests/${item.file}) ${item.last ? `answered ${statusText(item.last)}${item.before ? ` (it answered ${statusText(item.before)} before your last run)` : ""}` : "hasn't run yet"}:\n\n${item.last ? body(item.last).slice(0, 3000) : ""}\n\nWhat should it answer?`);
  return <>
    <div className="backend-detail-head">
      <span className="backend-method" data-method={item.method}>{item.method}</span>
      <span className="backend-row-text"><span className="backend-row-name">{item.name}</span><code className="backend-row-sub">{item.url}</code></span>
    </div>
    {error && <div className="banner inline" data-tone="danger" role="alert">{error}</div>}
    {item.last ? <>
      <div className="backend-status">
        <span className="badge" data-tone={statusTone(item.last)}>{item.last.error ? "No answer" : `${item.last.status} ${item.last.statusText}`.trim()}</span>
        {item.before && item.before.status !== item.last.status && <span className="backend-meta">was {statusText(item.before)}</span>}
        <span className="backend-meta">{item.last.ms} ms · {ago(item.last.at)}</span>
      </div>
      <Switch label="Show the answer" value={side} onChange={setSide} options={[
        { id: "before", label: "Before", disabled: !item.before }, { id: "now", label: "Now" }, { id: "changes", label: "Changes", disabled: !item.before },
      ]} />
      {side === "changes" ? <Changes changes={detail.changes ?? []} empty="The same answer as before the agent's last run." />
        : shown ? <pre className="backend-body">{body(shown)}{shown.truncated ? "\n… (cut at 1 MB)" : ""}</pre> : null}
    </> : <p className="backend-empty">Not run yet.</p>}
    <details className="backend-request"><summary>Request</summary>
      <pre className="backend-body">{[`${request.method} ${request.url}`, ...request.headers.map(([key, value]) => `${key}: ${value}`), ...(request.body ? ["", request.body] : [])].join("\n")}</pre>
    </details>
    <div className="backend-actions">
      <button className="btn ghost" disabled={!item.last} onClick={draft}>Send to agent…</button>
      <button className="btn primary" disabled={!online || busy} onClick={() => item.auto ? void run() : setConfirm(true)}>{busy ? <Spinner size="xs" /> : null}{item.last ? "Run again" : "Run"}</button>
    </div>
    {confirm && <ConfirmDialog title={`Run ${item.method} ${item.name}?`}
      message={`This sends ${item.method} ${item.url} from this machine. It may change data${item.external ? ` on ${item.external}, which isn't this app's server` : ""}.`}
      confirmLabel="Run it" danger={Boolean(item.external)} onCancel={() => setConfirm(false)} onConfirm={() => void run()} />}
  </>;
}

// Data -------------------------------------------------------------------------

function DataPane({ ask, item, online }: PaneProps) {
  const [result, setResult] = useState<DataViewResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = async (run: boolean) => {
    setBusy(true); setError("");
    try { setResult(await ask<DataViewResult>("apps.data", run ? { run } : {})); }
    catch (e) { setError(errorText(e, "Could not run the queries.")); }
    finally { setBusy(false); }
  };
  useEffect(() => { void load(false); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!result) return error ? <div className="banner inline" data-tone="danger" role="alert">{error}</div> : <div className="apps-state" role="status"><Spinner size="sm" /><span>Running queries…</span></div>;
  return <>
    <div className="backend-toolbar">
      <span className="backend-meta">{result.queries.length === 1 ? "1 saved query" : `${result.queries.length} saved queries`}</span>
      <button className="btn sm" disabled={!online || busy} onClick={() => void load(true)}>{busy ? <Spinner size="xs" /> : null}Run again</button>
    </div>
    {error && <div className="banner inline" data-tone="danger" role="alert">{error}</div>}
    {result.problems.map((problem) => <div key={problem.file} className="banner inline" data-tone="warn" role="status"><span className="banner-text"><code>{problem.file}</code> {problem.error}</span></div>)}
    {!result.queries.length && <div className="apps-empty">
      <strong>No saved queries yet</strong>
      <p>Queries are <code>.sql</code> files in <code>.bivy/queries</code>. Start one with <code>-- key: id</code> so changed rows can be matched. Ask the agent to add the ones that show what it changed.</p>
    </div>}
    {result.queries.map((query) => <QuerySection key={query.id} query={query} focused={query.id === item} />)}
  </>;
}
const counts = (changes: NonNullable<DataQuery["changes"]>) => changes.added.length + changes.changed.length + changes.removed.length;
function QuerySection({ query, focused }: { query: DataQuery; focused: boolean }) {
  const changed = query.changes ? counts(query.changes) : 0;
  // Since a run began, what changed is the point; nothing changed says so in one line.
  const [side, setSide] = useState<"changes" | "now">(query.changes ? "changes" : "now");
  const ref = useRef<HTMLElement>(null);
  useEffect(() => { if (focused) ref.current?.scrollIntoView({ block: "start" }); }, [focused]);
  return <section ref={ref} className="backend-query" aria-label={query.title}>
    <div className="backend-query-head">
      <h3>{query.title}</h3>
      {changed > 0 && query.changes && <span className="backend-counts" aria-label={`${query.changes.added.length} added, ${query.changes.changed.length} changed, ${query.changes.removed.length} removed since the agent's last run began`}>
        {query.changes.added.length > 0 && <span data-tone="ok">+{query.changes.added.length} </span>}
        {query.changes.changed.length > 0 && <span data-tone="warn">~{query.changes.changed.length} </span>}
        {query.changes.removed.length > 0 && <span data-tone="danger">−{query.changes.removed.length}</span>}
      </span>}
    </div>
    {query.error ? <div className="banner inline" data-tone="danger" role="alert"><span className="banner-text">{query.error}</span></div> : <>
      {query.changes && <Switch label={`Show ${query.title}`} value={side} onChange={setSide} options={[{ id: "changes", label: "Changes" }, { id: "now", label: "Now" }]} />}
      {side === "changes" && query.changes
        ? changed ? <ul className="backend-list">{[
            ...query.changes.added.map((row) => <RowCard key={`+${row.key}`} kind="added" row={row} keyName={query.key} />),
            ...query.changes.changed.map((row) => <RowCard key={`~${row.key}`} kind="changed" row={row} keyName={query.key} />),
            ...query.changes.removed.map((row) => <RowCard key={`-${row.key}`} kind="removed" row={row} keyName={query.key} />),
          ]}</ul> : <p className="backend-empty">No changes · {query.count} {query.count === 1 ? "row" : "rows"}</p>
        : <RowsTable query={query} />}
    </>}
    <p className="backend-foot"><code>{query.file}</code>, keyed by <code>{query.key}</code>{query.at ? ` · ran ${ago(query.at)}` : ""}</p>
  </section>;
}
const KIND_LABEL = { added: "Added", changed: "Changed", removed: "Removed" } as const;
function RowCard({ kind, row, keyName }: { kind: keyof typeof KIND_LABEL; row: DataRowChange; keyName: string }) {
  const fields: ValueChange[] = kind === "changed" ? row.fields ?? [] : Object.entries(row.row).filter(([column]) => column !== keyName).map(([path, value]) => ({ path, after: value }));
  return <li className="backend-rowcard" data-kind={kind}>
    <span className="backend-row-name"><span className="sr-only">{KIND_LABEL[kind]}: </span>{row.key}</span>
    <dl className="backend-fields">{fields.slice(0, 12).map((field) => <div key={field.path}>
      <dt>{field.path}</dt>
      <dd>{kind === "changed" && field.before !== undefined && <><s className="backend-was">{field.before}</s>{" "}</>}{kind === "removed" ? <s>{field.after}</s> : field.after}</dd>
    </div>)}</dl>
  </li>;
}
function RowsTable({ query }: { query: DataQuery }) {
  if (!query.rows.length) return <p className="backend-empty">No rows.</p>;
  return <div className="backend-table-wrap"><table className="backend-table">
    <thead><tr>{query.columns.map((column) => <th key={column} scope="col">{column}</th>)}</tr></thead>
    <tbody>{query.rows.map((row, index) => <tr key={row[query.key] ?? index}>{query.columns.map((column) => <td key={column}>{row[column]}</td>)}</tr>)}</tbody>
  </table>{query.count > query.rows.length && <p className="backend-foot">Showing {query.rows.length} of {query.count} rows.</p>}</div>;
}

// Logs -------------------------------------------------------------------------

const POLL_MS = 2000;
const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
function LogsPane({ ask, onDraft, app }: PaneProps) {
  const [result, setResult] = useState<LogsViewResult | null>(null);
  const [errorsOnly, setErrorsOnly] = useState<"all" | "errors">("all");
  const [error, setError] = useState("");
  const scrolled = useRef(false);
  const lastMark = useRef<HTMLLIElement>(null);
  useEffect(() => {
    let live = true, timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try { const next = await ask<LogsViewResult>("apps.serverLog"); if (live) { setResult(next); setError(""); } }
      catch (e) { if (live) setError(errorText(e, "Could not read the logs.")); }
      if (live) timer = setTimeout(() => void poll(), POLL_MS);
    };
    void poll();
    return () => { live = false; clearTimeout(timer); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Open where it matters: the last thing that happened.
  useEffect(() => { if (result && !scrolled.current && lastMark.current) { scrolled.current = true; lastMark.current.scrollIntoView({ block: "start" }); } }, [result]);
  if (!result) return error ? <div className="banner inline" data-tone="danger" role="alert">{error}</div> : <div className="apps-state" role="status"><Spinner size="sm" /><span>Reading logs…</span></div>;
  const mark = result.marks.at(-1);
  const after = result.lines.filter((line) => !mark || line.at >= mark.at);
  const newErrors = after.filter((line) => line.level === "error");
  const timeline: ({ mark: LogMark } | { line: LogLine })[] = [
    ...result.lines.filter((line) => errorsOnly === "all" || line.level === "error").map((line) => ({ line })),
    ...result.marks.map((item) => ({ mark: item })),
  ].sort((a, b) => ("mark" in a ? a.mark.at - 0.5 : a.line.at) - ("mark" in b ? b.mark.at - 0.5 : b.line.at));
  const draft = () => onDraft(`${app.name}'s server logged ${newErrors.length === 1 ? "an error" : `${newErrors.length} errors`}${mark ? ` after “${mark.label}” (${clock(mark.at)})` : ""}:\n\n${after.slice(-40).map((line) => line.text).join("\n")}\n\nPlease find the cause and fix it.`);
  return <>
    <div className="backend-toolbar">
      <Switch label="Show" value={errorsOnly} onChange={setErrorsOnly} options={[{ id: "all", label: "All" }, { id: "errors", label: `Errors${result.lines.some((line) => line.level === "error") ? ` (${result.lines.filter((line) => line.level === "error").length})` : ""}` }]} />
      {!result.running && <span className="badge" data-tone="warn">Not running</span>}
    </div>
    {error && <div className="banner inline" data-tone="danger" role="alert">{error}</div>}
    {!result.lines.length && <p className="backend-empty">{result.running ? "Nothing logged yet. Use the app, or run a request, and its output shows here." : "The server isn't running, so there's nothing to show. Open the app's preview to start it."}</p>}
    <ol className="backend-log" aria-label="Log">
      {timeline.map((entry, index) => "mark" in entry
        ? <li key={`m${entry.mark.at}`} ref={entry.mark === mark ? lastMark : undefined} className="backend-mark">{entry.mark === mark ? "Your last action" : "Action"} · {entry.mark.label} · {clock(entry.mark.at)}</li>
        : <li key={index} className="backend-line" data-level={entry.line.level}>
            {entry.line.level === "error" && <span className="badge" data-tone="danger">error</span>}
            <span className="backend-line-time">{clock(entry.line.at)}</span> {entry.line.text}
          </li>)}
    </ol>
    <div className="backend-actions">
      <button className={`btn${newErrors.length ? " primary" : ""}`} disabled={!after.length} onClick={draft}>{newErrors.length ? `Send ${newErrors.length === 1 ? "error" : "errors"} to agent…` : "Send to agent…"}</button>
    </div>
  </>;
}
