// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useMemo, useState } from "react";
import type { SessionChangeEntry } from "@bivy/core";
import { Sheet } from "./Sheet.js";
import { countLines, TreeNode, relTime } from "./ChangesCard.js";
import { buildFileTree } from "../fileTree.js";
import { controller } from "../store/useStore.js";
import { buildChangeSetReviewPrompt } from "../changeReviewPrompt.js";
import type { DiffMode } from "./DiffView.js";

// Full-session file changes. Reached from the run pill / session summary sheet
// ("N files edited"), not from a bulky card above the composer — so chat stays
// clean and review lives with the rest of the session outcome.

function TurnEntry({ entry, mode }: { entry: SessionChangeEntry; mode: DiffMode }) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const totals = useMemo(() => {
    let added = 0;
    let removed = 0;
    for (const f of entry.files) { const c = countLines(f); added += c.added; removed += c.removed; }
    return { added, removed };
  }, [entry.files]);
  const tree = useMemo(() => buildFileTree(entry.files.map((f) => ({ path: f.path, status: f.status, added: f.added, removed: f.removed }))), [entry.files]);
  const byPath = useMemo(() => new Map(entry.files.map((f) => [f.path, f])), [entry.files]);
  const n = entry.files.length;

  const undo = () => {
    if (!entry.before) return;
    setPending(true);
    controller.rewind(entry.before);
  };

  return (
    <div className="session-changes-turn">
      <button
        type="button"
        className="session-changes-turn-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="changes-chevron" aria-hidden>{open ? "▾" : "▸"}</span>
        <span className="session-changes-turn-title">
          {n} file{n === 1 ? "" : "s"} changed
          {(totals.added > 0 || totals.removed > 0) && (
            <span className="changes-total">
              {totals.added > 0 && <span className="add">+{totals.added}</span>}
              {totals.removed > 0 && <span className="del">−{totals.removed}</span>}
            </span>
          )}
        </span>
        <span className="session-changes-turn-time">{relTime(entry.at)}</span>
      </button>
      {open && (
        <div className="session-changes-turn-body">
          {entry.before && (
            <button type="button" className="btn danger-ghost changes-undo" onClick={undo} disabled={pending}>
              {pending ? "Undoing…" : "Rewind to before this turn"}
            </button>
          )}
          <div className="changes-files">
            {tree.map((node) => (
              <TreeNode key={node.path} node={node} byPath={byPath} mode={mode} depth={0} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Unique paths touched across every turn in the session. */
export function countUniqueEditedFiles(history: SessionChangeEntry[]): number {
  const paths = new Set<string>();
  for (const entry of history) {
    for (const f of entry.files) paths.add(f.path);
  }
  return paths.size;
}

export function SessionChangesSheet({
  history,
  onClose,
  checks,
}: {
  history: SessionChangeEntry[];
  onClose: () => void;
  checks?: { name: string; status: "passed" | "failed" | "skipped" }[];
}) {
  const [mode, setMode] = useState<DiffMode>("unified");
  const [undoing, setUndoing] = useState(false);
  // Newest first — a user opening the sheet mid-session almost always wants
  // "what did it just do", not to scroll past everything to find it.
  const ordered = useMemo(() => [...history].reverse(), [history]);
  const uniqueFiles = useMemo(() => countUniqueEditedFiles(history), [history]);
  const latest = ordered[0];
  const latestTotals = useMemo(() => {
    if (!latest) return { added: 0, removed: 0 };
    let added = 0;
    let removed = 0;
    for (const f of latest.files) {
      const c = countLines(f);
      added += c.added;
      removed += c.removed;
    }
    return { added, removed };
  }, [latest]);

  const reviewLatest = () => {
    if (!latest) return;
    controller.prefillComposer(buildChangeSetReviewPrompt(
      latest.files.map((file) => ({ ...file, ...countLines(file) })),
      checks,
    ));
    onClose();
  };
  const undoLatest = () => {
    if (!latest?.before) return;
    setUndoing(true);
    controller.rewind(latest.before);
  };

  const title = uniqueFiles > 0
    ? `${uniqueFiles} file${uniqueFiles === 1 ? "" : "s"} edited`
    : "Session changes";

  return (
    <Sheet
      title={title}
      onClose={onClose}
      autoFocusSearch={false}
      headExtra={
        <div className="changes-mode" role="group" aria-label="Diff view mode">
          <button type="button" className={mode === "unified" ? "active" : ""} onClick={() => setMode("unified")}>Unified</button>
          <button type="button" className={mode === "split" ? "active" : ""} onClick={() => setMode("split")}>Split</button>
        </div>
      }
    >
      {latest && (
        <div className="session-changes-toolbar">
          <span className="session-changes-toolbar-meta">
            Latest turn
            {(latestTotals.added > 0 || latestTotals.removed > 0) && (
              <span className="changes-total">
                {latestTotals.added > 0 && <span className="add">+{latestTotals.added}</span>}
                {latestTotals.removed > 0 && <span className="del">−{latestTotals.removed}</span>}
              </span>
            )}
          </span>
          <div className="session-changes-toolbar-actions">
            <button type="button" className="btn sm" onClick={reviewLatest}>Review with agent</button>
            {latest.before && (
              <button type="button" className="btn sm danger-ghost" onClick={undoLatest} disabled={undoing}>
                {undoing ? "Undoing…" : "Undo turn"}
              </button>
            )}
          </div>
        </div>
      )}
      <div className="session-changes-list">
        {ordered.length === 0 && <div className="changes-binary">No file changes yet this session.</div>}
        {ordered.map((entry) => <TurnEntry key={entry.id} entry={entry} mode={mode} />)}
      </div>
    </Sheet>
  );
}
