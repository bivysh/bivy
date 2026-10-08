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
import { useMemo } from "react";
import { componentKind, type AttachmentRef, type PromptAttachment } from "@bivy/core";

import { AttachmentChip } from "./AttachmentChip.js";
import { useAttachmentText } from "../attachmentUrl.js";
import { parseCsv } from "../csv.js";

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

/** kind → renderer. The whole registry. */
const REGISTRY: Record<string, (args: RenderArgs) => React.ReactNode> = {
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
export function MessageComponent({ placement, refs }: { placement: Placement; refs?: Record<string, AttachmentRef> }) {
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
  return <>{render({ placement, attachment })}</>;
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
