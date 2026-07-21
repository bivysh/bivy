// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { useMemo, useState } from "react";
import type { TurnChanges, HarnessFileChange, Checkpoint } from "@bivy/core";
import { diffOps } from "@bivy/core";
import { DiffView } from "./DiffView.js";
import { controller } from "../store/useStore.js";

// Universal Agent Harness — "files changed this turn" + rewind timeline.
//
// The node captures a git checkpoint before and after every turn and sends the
// structured diff as `session.changes`, for ANY agent (Pi, Claude Code, Codex,
// Goose, Gemini, or a dumb-pipe CLI). This card renders that diff (with per-file
// +/- counts) and offers a universal undo — either the last turn, or any earlier
// checkpoint from the lazily-loaded timeline.

const STATUS_GLYPH: Record<HarnessFileChange["status"], string> = { added: "+", modified: "~", deleted: "−" };

function countLines(file: HarnessFileChange): { added: number; removed: number } {
  // Prefer the node's authoritative `git diff --numstat` counts. The client-side
  // differ (diffOps) caps at 900 lines and, above that, degrades to "delete every
  // old line + add every new line" — so a one-line edit to a big file (lockfile,
  // generated bundle) reported ~2× the file size (the ~10k-line inflation). Only
  // fall back to the local count when the node didn't send numbers.
  if (typeof file.added === "number" && typeof file.removed === "number") {
    return { added: file.added, removed: file.removed };
  }
  if (file.binary) return { added: 0, removed: 0 };
  let added = 0;
  let removed = 0;
  for (const op of diffOps(file.oldText, file.newText)) {
    if (op.type === "add") added++;
    else if (op.type === "del") removed++;
  }
  return { added, removed };
}

function relTime(ms: number): string {
  if (!ms) return "";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}

function FileRow({ file }: { file: HarnessFileChange }) {
  const [open, setOpen] = useState(false);
  const { added, removed } = useMemo(() => countLines(file), [file]);
  return (
    <div className={`changes-file status-${file.status}`}>
      <button type="button" className="changes-file-head" onClick={() => setOpen((v) => !v)}>
        <span className="changes-file-glyph" aria-hidden>{STATUS_GLYPH[file.status]}</span>
        <span className="changes-file-path">{file.path}</span>
        {(added > 0 || removed > 0) && (
          <span className="changes-file-stat">
            {added > 0 && <span className="add">+{added}</span>}
            {removed > 0 && <span className="del">−{removed}</span>}
          </span>
        )}
      </button>
      {open && !file.binary && (
        <DiffView hunks={[{ oldText: file.oldText, newText: file.newText, added, removed, label: file.path }]} />
      )}
      {open && file.binary && <div className="changes-binary">Binary file — not shown.</div>}
    </div>
  );
}

function Timeline({ checkpoints }: { checkpoints: Checkpoint[] }) {
  const [rewinding, setRewinding] = useState<string | null>(null);
  if (checkpoints.length === 0) return <div className="changes-binary">No checkpoints yet.</div>;
  return (
    <div className="changes-timeline">
      {checkpoints.map((c) => (
        <div className="changes-cp" key={c.id}>
          <span className="changes-cp-label" title={c.label}>{c.label}</span>
          <span className="changes-cp-time">{relTime(c.createdAt)}</span>
          <button
            type="button"
            className="btn danger-ghost changes-cp-btn"
            disabled={rewinding !== null}
            onClick={() => { setRewinding(c.id); controller.rewind(c.id); }}
          >
            {rewinding === c.id ? "Rewinding…" : "Rewind here"}
          </button>
        </div>
      ))}
    </div>
  );
}

export function ChangesCard({ changes, checkpoints }: { changes: TurnChanges | null; checkpoints: Checkpoint[] }) {
  const [pending, setPending] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  // Hooks must run on every render in the same order, so compute this before any
  // early return (null-safe) rather than after the empty-changes guard below —
  // otherwise the hook count changes when `changes` becomes non-empty and React
  // corrupts hook state.
  const totals = useMemo(() => {
    let added = 0;
    let removed = 0;
    for (const f of changes?.files ?? []) { const c = countLines(f); added += c.added; removed += c.removed; }
    return { added, removed };
  }, [changes]);
  if (!changes || changes.files.length === 0) return null;
  const n = changes.files.length;

  const undo = () => {
    if (!changes.before) return;
    setPending(true);
    controller.rewind(changes.before);
  };
  const toggleHistory = () => {
    const next = !showHistory;
    setShowHistory(next);
    if (next) controller.listCheckpoints();
  };

  return (
    <div className={`changes-card${collapsed ? " collapsed" : ""}`}>
      <div className="changes-head">
        <button
          type="button"
          className="changes-collapse"
          onClick={() => setCollapsed((v) => !v)}
          aria-expanded={!collapsed}
          title={collapsed ? "Show changed files" : "Hide changed files"}
        >
          <span className="changes-chevron" aria-hidden>{collapsed ? "▸" : "▾"}</span>
          <span className="changes-title">
            {n} file{n === 1 ? "" : "s"} changed this turn
            {(totals.added > 0 || totals.removed > 0) && (
              <span className="changes-total">
                {totals.added > 0 && <span className="add">+{totals.added}</span>}
                {totals.removed > 0 && <span className="del">−{totals.removed}</span>}
              </span>
            )}
          </span>
        </button>
        <div className="changes-actions">
          <button type="button" className="changes-history-toggle" onClick={toggleHistory}>
            {showHistory ? "Hide history" : "History"}
          </button>
          {changes.before && (
            <button type="button" className="btn danger-ghost changes-undo" onClick={undo} disabled={pending}>
              {pending ? "Undoing…" : "Undo turn"}
            </button>
          )}
        </div>
      </div>
      {!collapsed && (
        <>
          <div className="changes-files">
            {changes.files.map((f) => (
              <FileRow key={f.path} file={f} />
            ))}
          </div>
          {showHistory && <Timeline checkpoints={checkpoints} />}
        </>
      )}
    </div>
  );
}
