// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useMemo, useState } from "react";
import type { TurnChanges, HarnessFileChange, Checkpoint } from "@bivy/core";
import { diffOps } from "@bivy/core";
import { DiffView, type DiffMode } from "./DiffView.js";
import { buildFileTree, reviewStates, reviewStateLabel, type FileTreeNode } from "../fileTree.js";
import { controller } from "../store/useStore.js";
import { buildChangeSetReviewPrompt, buildFileReviewPrompt } from "../changeReviewPrompt.js";

// Universal Agent Harness — the changed-file review surface (C3).
//
// The node captures a git checkpoint before and after every turn and sends the
// structured diff as `session.changes`, for ANY agent. This surface renders that
// diff as a directory tree (unified or side-by-side), shows which review states
// the run spans and its deterministic checks, and offers a universal undo plus
// per-file revert and "ask the agent about this file".

const STATUS_GLYPH: Record<HarnessFileChange["status"], string> = { added: "+", modified: "~", deleted: "−" };

interface RunChecks {
  name: string;
  status: "passed" | "failed" | "skipped";
}

function countLines(file: HarnessFileChange): { added: number; removed: number } {
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

function FileRow({ file, mode }: { file: HarnessFileChange; mode: DiffMode }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const { added, removed } = useMemo(() => countLines(file), [file]);
  const revert = () => {
    // Pre-turn content is the diff's own oldText; an added file reverts to removal.
    setBusy(true);
    controller.revertFile(file.path, file.status === "added" ? null : file.oldText);
  };
  const ask = () => controller.prefillComposer(buildFileReviewPrompt({ ...file, added, removed }));
  return (
    <div className={`changes-file status-${file.status}`}>
      <div className="changes-file-head">
        <button type="button" className="changes-file-open" onClick={() => setOpen((v) => !v)}>
          <span className="changes-file-glyph" aria-hidden>{STATUS_GLYPH[file.status]}</span>
          <span className="changes-file-path">{file.path}</span>
          {(added > 0 || removed > 0) && (
            <span className="changes-file-stat">
              {added > 0 && <span className="add">+{added}</span>}
              {removed > 0 && <span className="del">−{removed}</span>}
            </span>
          )}
        </button>
        <span className="changes-file-actions">
          <button type="button" className="changes-file-act" onClick={ask} title="Ask the agent about this file">Ask</button>
          <button type="button" className="changes-file-act danger" onClick={revert} disabled={busy} title="Revert this file to its pre-turn state">
            {busy ? "…" : "Revert"}
          </button>
        </span>
      </div>
      {open && !file.binary && (
        <DiffView hunks={[{ oldText: file.oldText, newText: file.newText, added, removed, label: file.path }]} mode={mode} />
      )}
      {open && file.binary && <div className="changes-binary">Binary file — not shown.</div>}
    </div>
  );
}

/** Render the directory tree; files carry a per-file DiffView + actions. */
function TreeNode({ node, byPath, mode, depth }: { node: FileTreeNode; byPath: Map<string, HarnessFileChange>; mode: DiffMode; depth: number }) {
  const [open, setOpen] = useState(true);
  if (node.type === "file") {
    const file = byPath.get(node.path);
    return file ? <div style={{ paddingLeft: depth * 12 }}><FileRow file={file} mode={mode} /></div> : null;
  }
  return (
    <div className="changes-dir">
      <button type="button" className="changes-dir-head" style={{ paddingLeft: depth * 12 }} onClick={() => setOpen((v) => !v)}>
        <span className="changes-chevron" aria-hidden>{open ? "▾" : "▸"}</span>
        <span className="changes-dir-name">{node.name}/</span>
      </button>
      {open && node.children?.map((child) => (
        <TreeNode key={child.path} node={child} byPath={byPath} mode={mode} depth={depth + 1} />
      ))}
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

export function ChangesCard({
  changes,
  checkpoints,
  checks,
  output,
}: {
  changes: TurnChanges | null;
  checkpoints: Checkpoint[];
  /** The run's deterministic checks, shown beside the changes (C3c). */
  checks?: RunChecks[];
  /** Output refs so the surface can say which review states the run spans (C3b). */
  output?: { branch?: string; commit?: string; prUrl?: string };
}) {
  const [pending, setPending] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [mode, setMode] = useState<DiffMode>("unified");
  const totals = useMemo(() => {
    let added = 0;
    let removed = 0;
    for (const f of changes?.files ?? []) { const c = countLines(f); added += c.added; removed += c.removed; }
    return { added, removed };
  }, [changes]);
  const tree = useMemo(() => buildFileTree((changes?.files ?? []).map((f) => ({ path: f.path, status: f.status, added: f.added, removed: f.removed }))), [changes]);
  const byPath = useMemo(() => new Map((changes?.files ?? []).map((f) => [f.path, f])), [changes]);
  const states = useMemo(() => reviewStates({ hasWorkingChanges: (changes?.files.length ?? 0) > 0, hasCheckpoint: Boolean(changes?.before || changes?.after), output }), [changes, output]);
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
  const reviewChanges = () => controller.prefillComposer(buildChangeSetReviewPrompt(
    changes.files.map((file) => ({ ...file, ...countLines(file) })),
    checks,
  ));

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
          <button type="button" className="changes-history-toggle" onClick={reviewChanges} title="Draft a review prompt in the composer">
            Review with agent
          </button>
          <div className="changes-mode" role="group" aria-label="Diff view mode">
            <button type="button" className={mode === "unified" ? "active" : ""} onClick={() => setMode("unified")}>Unified</button>
            <button type="button" className={mode === "split" ? "active" : ""} onClick={() => setMode("split")}>Split</button>
          </div>
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
        <div className="changes-body" role="region" aria-label="Code changes" tabIndex={0}>
          {(states.length > 0 || (checks && checks.length > 0)) && (
            <div className="changes-meta">
              {states.length > 0 && (
                <span className="changes-states">
                  {states.map((s) => <span key={s} className={`chip state-${s}`}>{reviewStateLabel(s)}</span>)}
                </span>
              )}
              {checks && checks.length > 0 && (
                <span className="changes-checks">
                  {checks.map((c, i) => (
                    <span key={`${c.name}-${i}`} className={`chk ${c.status}`}>
                      {c.name} {c.status === "passed" ? "✓" : c.status === "failed" ? "✗" : "–"}
                    </span>
                  ))}
                </span>
              )}
            </div>
          )}
          <div className="changes-files">
            {tree.map((node) => (
              <TreeNode key={node.path} node={node} byPath={byPath} mode={mode} depth={0} />
            ))}
          </div>
          {showHistory && <Timeline checkpoints={checkpoints} />}
        </div>
      )}
    </div>
  );
}
