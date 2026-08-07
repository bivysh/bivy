// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useMemo, useState } from "react";
import type { SessionChangeEntry } from "@bivy/core";
import { Sheet } from "./Sheet.js";
import { countLines, TreeNode, relTime } from "./ChangesCard.js";
import { buildFileTree } from "../fileTree.js";
import { controller } from "../store/useStore.js";
import type { DiffMode } from "./DiffView.js";

// The durable counterpart to ChangesCard: that card only ever shows the
// CURRENT turn's diff and is retired the instant the next turn starts (see
// AppState.changes), so a user who steps away mid-review loses the file list
// as soon as the agent keeps going. `changesHistory` never gets cleared for
// that reason — this sheet is where every turn's changes stay reachable for as
// long as the session is open, not just whichever turn happened to be live.

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

export function SessionChangesSheet({ history, onClose }: { history: SessionChangeEntry[]; onClose: () => void }) {
  const [mode, setMode] = useState<DiffMode>("unified");
  // Newest first — a user opening the sheet mid-session almost always wants
  // "what did it just do", not to scroll past everything to find it.
  const ordered = useMemo(() => [...history].reverse(), [history]);
  return (
    <Sheet
      title="Session changes"
      onClose={onClose}
      autoFocusSearch={false}
      headExtra={
        <div className="changes-mode" role="group" aria-label="Diff view mode">
          <button type="button" className={mode === "unified" ? "active" : ""} onClick={() => setMode("unified")}>Unified</button>
          <button type="button" className={mode === "split" ? "active" : ""} onClick={() => setMode("split")}>Split</button>
        </div>
      }
    >
      <div className="session-changes-list">
        {ordered.length === 0 && <div className="changes-binary">No file changes yet this session.</div>}
        {ordered.map((entry) => <TurnEntry key={entry.id} entry={entry} mode={mode} />)}
      </div>
    </Sheet>
  );
}
