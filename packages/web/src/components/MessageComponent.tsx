// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// One registry for everything an agent places inside its message.
//
// The renderer (packages/core/src/markdown.ts) leaves an empty `.md-component`
// mount point wherever the agent wrote `::view{src=…}` or a ```bivy fence, and
// ChatView portals one of these into each. What a placement renders as is a ROW
// in the table below, keyed by `componentKind`. Adding a kind means adding a row
// — not another field on TranscriptEntry, another branch in EntryView, and
// another near-identical card, which is how the chat accumulated five of them.
//
// Two rules the table has to keep:
//
//   1. Reuse, don't re-style. A file renders as the SAME AttachmentChip the
//      composer's paperclip and `bivy attach` produce. See packages/web/AGENTS.md.
//   2. Degrade visibly, never silently. An unknown kind, an unresolved
//      reference, or a spec this build cannot read all render something that
//      names what the agent meant. Agents get syntax wrong; a message that
//      quietly loses a third of itself is worse than one that says so.
import { useEffect, useMemo, useRef, useState } from "react";
import { componentKind, specReferences, type AttachmentRef, type PromptAttachment } from "@bivy/core";

import { AttachmentChip } from "./AttachmentChip.js";
import { InlineApp } from "./InlineApp.js";
import { MAX_COMPONENT_TEXT_BYTES, useAttachmentText } from "../attachmentUrl.js";
import { csvToObjects, parseCsv } from "../csv.js";
import { renderChart, substituteWorkspaceData } from "../vega.js";
import { controller } from "../store/useStore.js";

/** What the renderer put in the mount point's data attributes. */
export interface Placement {
  /** Workspace reference from a directive, if any. */
  ref: string | null;
  /** Inline spec from a ```bivy fence, if any. */
  spec: Record<string, unknown> | null;
  /** The directive's other attributes (`caption`, `height`, …). */
  attrs: Record<string, string | true>;
}

/** Everything a row of the table gets. */
interface RenderArgs {
  placement: Placement;
  /** The resolved attachment for `placement.ref`, once the node has stored it. */
  attachment: AttachmentRef | null;
  /** Every resolved reference on this entry. A kind whose SPEC points at files
   *  (a chart's `data.url`) needs more than its own `placement.ref`. */
  refs?: Record<string, AttachmentRef>;
  /** The session this transcript belongs to. Passed down rather than read from
   *  the active session, so a kind that talks to the machine asks about the
   *  right one and can be rendered on its own in a test. */
  sessionId: string | null;
}

/** An AttachmentRef is what the node stored; AttachmentChip wants the richer
 *  PromptAttachment shape. The bytes are fetched by hash either way (see
 *  useAttachmentUrl), so this is a straight widening — no second fetch path. */
function asAttachment(ref: AttachmentRef, caption?: string): PromptAttachment {
  return { kind: ref.kind, name: ref.name, size: ref.size, mimeType: ref.mimeType, hash: ref.hash, description: caption };
}

function captionOf(placement: Placement): string | undefined {
  const caption = placement.attrs.caption;
  return typeof caption === "string" && caption.trim() ? caption : undefined;
}

/**
 * The quiet fallback. Names what the agent pointed at and why nothing is shown,
 * using the existing muted-card vocabulary rather than a new "error" look — a
 * component that hasn't resolved is not an error the reader caused.
 */
function Unavailable({ what, why }: { what: string; why: string }) {
  return (
    <div className="card" data-tone="muted">
      <div className="card-title">{what}</div>
      <div className="card-sub">{why}</div>
    </div>
  );
}

/** A value the agent wants read at a glance — "4 650 kWh", "12 failing". Not a
 *  badge (which carries a state) and not a meter (which carries a proportion):
 *  the number IS the content, so it gets the message's largest type and its
 *  label sits under it in the muted voice every caption already uses. */
function Metric({ spec }: { spec: Record<string, unknown> }) {
  const value = spec.value;
  const label = spec.label;
  if (value === undefined || value === null || value === "") {
    return <Unavailable what="A number" why="This component has no value to show." />;
  }
  return (
    <div className="card metric-component">
      <div className="metric-value">{String(value)}</div>
      {label !== undefined && label !== null && label !== "" && <div className="card-sub">{String(label)}</div>}
    </div>
  );
}

/** Rows from a spec (`columns` + `rows`) or from a CSV file the node stored.
 *  Renders into the SAME .markdown-table-wrap a markdown pipe table uses, so a
 *  table reads identically however the agent produced it. */
function Table({ placement, attachment }: RenderArgs) {
  const spec = placement.spec;
  const fromSpec = Array.isArray(spec?.columns) && Array.isArray(spec?.rows);
  const file = attachment ? asAttachment(attachment) : null;
  // Hooks run unconditionally; the fetch is skipped when there is no file.
  const text = useAttachmentText(fromSpec ? null : file);
  const parsed = useMemo(() => (text.state === "ready" ? parseCsv(text.text) : null), [text]);

  if (fromSpec) {
    const columns = (spec!.columns as unknown[]).map(String);
    const rows = (spec!.rows as unknown[]).map((r) => (Array.isArray(r) ? r.map(String) : [String(r)]));
    return <Grid caption={captionOf(placement) ?? (typeof spec!.title === "string" ? spec!.title : undefined)} header={columns} rows={rows} omitted={0} />;
  }
  if (!attachment) return <Unavailable what={placement.ref ?? "A table"} why="This table is still being prepared, or could not be read." />;
  if (text.state === "error") return <Unavailable what={placement.ref ?? attachment.name} why={text.reason} />;
  if (!parsed) return <Unavailable what={placement.ref ?? attachment.name} why="Reading this file…" />;
  if (!parsed.header.length) return <Unavailable what={placement.ref ?? attachment.name} why="This file has no rows to show." />;
  return <Grid caption={captionOf(placement) ?? attachment.name} header={parsed.header} rows={parsed.rows} omitted={parsed.omitted} />;
}

function Grid({ caption, header, rows, omitted }: { caption?: string; header: string[]; rows: string[][]; omitted: number }) {
  return (
    <figure className="table-component">
      <div className="markdown-table-wrap">
        <table>
          <thead>
            <tr>{header.map((cell, i) => <th key={i}>{cell}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r}>{header.map((_, c) => <td key={c}>{row[c] ?? ""}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
      {(caption || omitted > 0) && (
        <figcaption className="card-sub">
          {caption}
          {omitted > 0 && `${caption ? " · " : ""}${omitted} more row${omitted === 1 ? "" : "s"} not shown`}
        </figcaption>
      )}
    </figure>
  );
}

/**
 * One dataset a chart points at, as rows. Returns null when the file cannot be
 * read as data, which the caller turns into a sentence naming the file — a
 * chart that silently plots nothing is worse than one that says why.
 *
 * The bytes come from the node's attachment store, where the reference was
 * resolved under the usual workspace confinement; nothing is fetched from the
 * network here. `.json` is taken as-is (Vega-Lite accepts an array of objects),
 * anything else is read as delimited text.
 */
async function loadChartData(path: string, ref: AttachmentRef): Promise<unknown[] | null> {
  if (ref.size > MAX_COMPONENT_TEXT_BYTES) return null;
  const res = await controller.fetchAttachment(ref.hash);
  if (!res) return null;
  let text: string;
  try {
    const binary = atob(res.data);
    text = new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
  if (/\.json$/i.test(path) || (ref.mimeType || "").includes("json")) {
    try {
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  const rows = csvToObjects(text);
  return rows.length ? rows : null;
}

/**
 * A Vega-Lite chart. Drawn imperatively into a host node because Vega owns the
 * SVG it produces — React must not reconcile inside it — which is the same
 * arrangement Mermaid already has with fenced diagrams.
 *
 * The renderer arrives in a lazy chunk, so `loading` is a real state here and
 * not a formality. It stays silent (an empty box at the chart's height) rather
 * than flashing a spinner for what is usually a few hundred milliseconds.
 */
function Chart({ placement, refs }: RenderArgs) {
  const host = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const spec = placement.spec;
  const height = Number(placement.attrs.height) || 0;

  // A spec may point at a dataset instead of carrying every row (`data.url`).
  // Those paths were resolved by the node like any other reference, so the rows
  // are fetched here and substituted into the spec before Vega sees it — Vega
  // itself never loads anything. A reference still waiting on the node leaves
  // the chart in `loading`, which is the same state a slow renderer produces.
  // Serialized for the same reason as specJson below: `spec` and `refs` are
  // fresh objects on every render, so an effect depending on them directly
  // would refetch constantly. This string changes exactly when a referenced
  // path changes or the node resolves one, and the effect reads its inputs back
  // out of it rather than closing over either object.
  const dataPlan = useMemo(
    () => JSON.stringify((spec ? specReferences(spec) : []).map((ref) => [ref, refs?.[ref] ?? null])),
    [spec, refs],
  );
  // Starts LOADING when the spec references anything. Starting "ready" with an
  // empty map would draw once with the `url` still in the spec, which
  // renderChart correctly refuses — and that refusal replaces the figure, so
  // the host node is gone by the time the data lands and the chart can never
  // recover.
  const [data, setData] = useState<{ state: "loading" | "ready" | "error"; byRef?: Map<string, unknown[]>; reason?: string }>(
    () => ((JSON.parse(dataPlan) as unknown[]).length ? { state: "loading" } : { state: "ready", byRef: new Map() }),
  );
  useEffect(() => {
    const planned = JSON.parse(dataPlan) as Array<[string, AttachmentRef | null]>;
    if (!planned.length) {
      setData({ state: "ready", byRef: new Map() });
      return;
    }
    // Still waiting on the node to resolve one of them.
    if (planned.some(([, ref]) => !ref)) {
      setData({ state: "loading" });
      return;
    }
    let cancelled = false;
    setData({ state: "loading" });
    void Promise.all(planned.map(async ([path, ref]) => [path, await loadChartData(path, ref!)] as const)).then((entries) => {
      if (cancelled) return;
      const bad = entries.find(([, rows]) => rows === null);
      if (bad) {
        setData({ state: "error", reason: `“${bad[0]}” could not be read as data.` });
        return;
      }
      setData({ state: "ready", byRef: new Map(entries as Array<[string, unknown[]]>) });
    });
    return () => {
      cancelled = true;
    };
  }, [dataPlan]);

  // The spec arrives as a fresh object on every markdown render, so the effect
  // keys on its SERIALIZED form — by identity, an unrelated re-render would tear
  // the chart down and redraw it. The effect reads the spec back from this
  // string rather than closing over the object, so its dependency is exactly
  // what it uses.
  // Drawn only once its data is in hand, so Vega is handed a spec with nothing
  // left to load. Serialized for the same reason as dataPlan above.
  const drawable = useMemo(
    () => (spec && data.state === "ready" ? JSON.stringify(substituteWorkspaceData(spec, data.byRef!)) : ""),
    [spec, data],
  );
  useEffect(() => {
    const node = host.current;
    if (!node || !drawable) return;
    let cancelled = false;
    node.replaceChildren();
    setFailed(null);
    void renderChart(node, JSON.parse(drawable) as Record<string, unknown>).then((result) => {
      if (cancelled || result.ok) return;
      if (result.reason) setFailed(result.reason);
    });
    return () => {
      cancelled = true;
      node.replaceChildren();
    };
  }, [drawable]);

  if (!spec) return <Unavailable what="A chart" why="This component has no chart to draw." />;
  const title = typeof spec.title === "string" ? spec.title : "A chart";
  if (data.state === "error") return <Unavailable what={title} why={data.reason!} />;
  if (failed) {
    return <Unavailable what={title} why={failed} />;
  }
  const caption = captionOf(placement) ?? (typeof spec.description === "string" ? spec.description : undefined);
  return (
    <figure className="chart-component">
      <div ref={host} className="chart-host" style={height ? { minHeight: `${height}px` } : undefined} />
      {caption && <figcaption className="card-sub">{caption}</figcaption>}
    </figure>
  );
}

/** kind → renderer. The whole registry. */
const REGISTRY: Record<string, (args: RenderArgs) => React.ReactNode> = {
  app: ({ placement, sessionId }) => {
    const appId = placement.spec?.appId;
    return typeof appId === "string"
      ? <InlineApp appId={appId} caption={captionOf(placement)} sessionId={sessionId} />
      : <Unavailable what="An app" why="This component names no app to show." />;
  },
  chart: (args) => <Chart {...args} />,
  metric: ({ placement }) =>
    placement.spec ? <Metric spec={placement.spec} /> : <Unavailable what="A number" why="This component has no value to show." />,
  table: (args) => <Table {...args} />,
  image: ({ placement, attachment }) =>
    attachment ? (
      <AttachmentChip attachment={asAttachment(attachment, captionOf(placement))} />
    ) : (
      <Unavailable what={placement.ref ?? "An image"} why="This image is still being prepared, or could not be read." />
    ),
  file: ({ placement, attachment }) =>
    attachment ? (
      <AttachmentChip attachment={asAttachment(attachment, captionOf(placement))} />
    ) : (
      <Unavailable what={placement.ref ?? "A file"} why="This file is still being prepared, or could not be read." />
    ),
};

/** Kinds this build can render, for the fallback's wording and for tests. */
export const RENDERABLE_KINDS = Object.keys(REGISTRY);

/**
 * Render one placement. `refs` is the entry's resolved reference map (see
 * TranscriptEntry.imageRefs) — a reference absent from it has not been resolved
 * yet, which is a normal transient while the node reads the file, so that case
 * renders the fallback rather than nothing.
 */
export function MessageComponent({ placement, refs, sessionId }: { placement: Placement; refs?: Record<string, AttachmentRef>; sessionId: string | null }) {
  const attachment = placement.ref ? refs?.[placement.ref] ?? null : null;
  const kind = useMemo(
    () => componentKind({ path: placement.ref, mimeType: attachment?.mimeType, spec: placement.spec }),
    [placement.ref, placement.spec, attachment?.mimeType],
  );
  const render = REGISTRY[kind];
  if (!render) {
    // A kind a NEWER node (or a newer agent note) knows and this client does
    // not. Naming the kind is what makes the message still useful, and tells
    // the reader their app is behind rather than the agent being broken.
    return (
      <Unavailable
        what={placement.ref ?? (typeof placement.spec?.title === "string" ? placement.spec.title : `A “${kind}” view`)}
        why={`This version of Bivy cannot show a “${kind}” yet.`}
      />
    );
  }
  return <>{render({ placement, attachment, refs, sessionId })}</>;
}

/**
 * Read a placement back out of a mount point the renderer emitted. Tolerant by
 * construction: a malformed attribute yields an empty object rather than
 * throwing, because this parses a string that travelled through HTML and a
 * thrown error here would blank the whole message.
 */
export function placementOf(node: HTMLElement): Placement {
  const json = (raw: string | undefined): Record<string, unknown> | null => {
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  return {
    ref: node.dataset.mdRef ?? null,
    spec: json(node.dataset.mdSpec),
    attrs: (json(node.dataset.mdAttrs) ?? {}) as Record<string, string | true>,
  };
}
