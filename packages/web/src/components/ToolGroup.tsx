// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { formatTool, toHtml, toolGroupSummary, toolRowLabel, type ToolActivity, type ToolFormat, type ToolGlyph } from "@bivy/core";
import { DiffView } from "./DiffView.js";
import { Sheet } from "./Sheet.js";

function GlyphIcon({ glyph }: { glyph: ToolGlyph }) {
  const common = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (glyph) {
    case "terminal":
      return (
        <svg {...common}><polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" /></svg>
      );
    case "pencil":
    case "create":
      return (
        <svg {...common}><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
      );
    case "search":
      return (
        <svg {...common}><circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
      );
    case "list":
      return (
        <svg {...common}><line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" /><line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" /></svg>
      );
    case "globe":
      return (
        <svg {...common}><circle cx="12" cy="12" r="9" /><line x1="3" y1="12" x2="21" y2="12" /><path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18Z" /></svg>
      );
    default:
      return (
        <svg {...common}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></svg>
      );
  }
}

function DiffStat({ added, removed }: { added: number; removed: number }) {
  if (!added && !removed) return null;
  return (
    <span className="tool-stat">
      {added > 0 && <span className="add">+{added}</span>}
      {removed > 0 && <span className="del">−{removed}</span>}
    </span>
  );
}

/** One selectable row in the activity sheet's list view — same icon/verb/desc/
 *  diff-stat look the row always had, just a drill-in chevron (›) instead of
 *  an inline expand/collapse caret, since selecting it now navigates the
 *  sheet to a detail view instead of revealing one in place. Takes the
 *  already-computed ToolFormat (the sheet computes one per tool for the list
 *  regardless, via toolGroupSummary) rather than recomputing formatTool here
 *  — for an Edit/Write call that's a real LCS diff pass, not free. */
function ToolListRow({ tool, f, onSelect }: { tool: ToolActivity; f: ToolFormat; onSelect: (callId: string) => void }) {
  const label = toolRowLabel(f);
  const running = tool.status === "running";
  return (
    <div className={`activity${running ? " is-running" : ""}`}>
      <button className="activity-row" onClick={() => onSelect(tool.callId)}>
        <span className="activity-ic">
          <GlyphIcon glyph={f.glyph} />
        </span>
        <span className="activity-verb">{f.verb}</span>
        <span className="activity-desc">{label}</span>
        <DiffStat added={f.added} removed={f.removed} />
        <span className="tool-chevron">›</span>
      </button>
    </div>
  );
}

/** The nested per-tool detail view — file/command/query/diff/output blocks.
 *  Unchanged content from the old inline-expand version, just no longer
 *  wrapped in its own toggle button since the sheet's back chevron is what
 *  navigates away from it now. Takes the ToolFormat computed once by the
 *  sheet rather than recomputing it (see ToolListRow's comment). */
function ToolDetail({ tool, f }: { tool: ToolActivity; f: ToolFormat }) {
  const output = tool.result || f.output || "";
  const showOutput = output && (f.diffs.length === 0 || f.command || f.verb === "Agent output");
  return (
    <div className="activity-detail">
      {f.path && (
        <div className="tool-detail-block">
          <div className="tool-detail-label">File</div>
          <div className="tool-detail-value">{f.path}</div>
        </div>
      )}
      {f.command && (
        <div className="tool-detail-block">
          <div className="tool-detail-label">Command</div>
          <div className="tool-detail-value">{f.command}</div>
        </div>
      )}
      {f.query && (
        <div className="tool-detail-block">
          <div className="tool-detail-label">Query</div>
          <div className="tool-detail-value">{f.query}</div>
        </div>
      )}
      {f.diffs.length > 0 && (
        <div className="tool-detail-block">
          <div className="tool-detail-label">Diff</div>
          <DiffView hunks={f.diffs} single={f.path} />
        </div>
      )}
      {f.diffs.length === 0 && f.edits ? (
        <div className="tool-detail-block">
          <div className="tool-detail-value output">{f.edits} targeted edits</div>
        </div>
      ) : null}
      {showOutput && (
        <div className="tool-detail-block">
          <div className="tool-detail-label">{tool.status === "running" ? "Live output" : "Output"}</div>
          <div className="tool-detail-value output" dangerouslySetInnerHTML={{ __html: toHtml(output) }} />
        </div>
      )}
      {!f.path && !f.command && !f.query && !f.diffs.length && !showOutput && (
        <div className="tool-detail-value output">{tool.status === "running" ? "Still working. Details will appear here when the agent streams them." : "No further details."}</div>
      )}
    </div>
  );
}

function runningSummary(tool: ToolActivity): string {
  const f = formatTool(tool.name, tool.input);
  if (f.verb === "Agent output") return "Reading agent output…";
  const label = toolRowLabel(f);
  if (f.command) return `Running ${label || "command"}…`;
  if (label) return `${f.verb} ${label}…`;
  return "Agent is working…";
}

/**
 * Bottom sheet for inspecting a tool-call batch — ported from the legacy
 * client's activity modal (list of calls, drill into one for its detail, a
 * back chevron to return) rather than the inline double-accordion this used
 * to be, which pushed the whole transcript around every time you looked at
 * one. Selecting by callId (not holding the ToolActivity object itself) so
 * the detail view keeps reflecting live updates — `tools` is a fresh array
 * every time the parent re-renders while a call is still streaming, and a
 * stale object reference would freeze the open card mid-run.
 */
function ToolActivitySheet({ tools, summary, onClose }: { tools: ToolActivity[]; summary: string; onClose: () => void }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = selectedId ? tools.find((t) => t.callId === selectedId) : undefined;
  // One formatTool per tool per render, not per tool per *place it's used* —
  // for an Edit/Write call formatTool runs a real LCS diff, so recomputing it
  // separately for the list row, the sheet title, and the detail view would
  // triple that work for no reason.
  const formatted = selected ? formatTool(selected.name, selected.input) : undefined;

  // The sheet's scrollable body is a single persistent DOM node (Sheet.tsx's
  // .sheet-content) that this component swaps between the list and a detail
  // view — without resetting it, drilling into a row (or going back) from a
  // scrolled-down position leaves the new content scrolled to the same
  // offset instead of starting at the top.
  const anchorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    anchorRef.current?.closest(".sheet-content")?.scrollTo(0, 0);
  }, [selectedId]);

  return (
    <Sheet
      title={selected && formatted ? formatted.title : summary}
      onClose={onClose}
      headExtra={
        selected ? (
          <button className="sheet-back" onClick={() => setSelectedId(null)} aria-label="Back">
            ‹
          </button>
        ) : undefined
      }
    >
      <div ref={anchorRef}>
        {selected && formatted ? (
          <ToolDetail tool={selected} f={formatted} />
        ) : tools.length ? (
          tools.map((t) => <ToolListRow key={t.callId} tool={t} f={formatTool(t.name, t.input)} onSelect={setSelectedId} />)
        ) : (
          <div className="tool-detail-value output">No tool activity.</div>
        )}
      </div>
    </Sheet>
  );
}

/**
 * A run of consecutive tool calls, rendered as one muted summary line in the
 * transcript that opens a bottom sheet to inspect — matching the legacy
 * client's activity-sheet model (see ToolActivitySheet above), rather than
 * expanding inline and shoving the rest of the chat around every time.
 */
export const ToolGroup = memo(function ToolGroup({ tools }: { tools: ToolActivity[] }) {
  const [open, setOpen] = useState(false);
  // Stable identity across re-renders: ChatView rebuilds `tools` (and so
  // re-renders this component) on every transcript change, not just ones
  // that touch this group — a fresh inline arrow here would make Sheet's
  // focus-trap effect (deps=[onClose]) tear down and re-run on each of those,
  // yanking focus back to the top of the sheet while a tool call streams.
  const close = useCallback(() => setOpen(false), []);
  const running = tools.some((t) => t.status === "running");
  const summary = running && tools.every((t) => t.status === "running") && tools.length === 1 ? runningSummary(tools[0]!) : toolGroupSummary(tools);
  return (
    <div className="tool-group">
      <button className={`tool-group-line${running ? " is-running" : ""}`} onClick={() => setOpen(true)}>
        <span className="tool-group-state" aria-hidden />
        <span className="tool-group-summary">{summary}</span>
        <span className="tool-chevron">›</span>
      </button>
      {open && <ToolActivitySheet tools={tools} summary={summary} onClose={close} />}
    </div>
  );
});
