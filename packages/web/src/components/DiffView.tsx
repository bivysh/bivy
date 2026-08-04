// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { memo } from "react";
import { compactDiffOps, diffOps, type DiffHunk } from "@bivy/core";

function DiffStat({ added, removed }: { added: number; removed: number }) {
  if (!added && !removed) return null;
  return (
    <span className="tool-stat">
      {added > 0 && <span className="add">+{added}</span>}
      {removed > 0 && <span className="del">−{removed}</span>}
    </span>
  );
}

const MAX_LINES = 420;

export type DiffMode = "unified" | "split";

/** Line-by-line diff viewer for Edit/Write hunks, matching the legacy client.
 *  `mode: "split"` renders old/new side-by-side (C3a); "unified" is the default. */
export const DiffView = memo(function DiffView({ hunks, single, mode = "unified" }: { hunks: DiffHunk[]; single?: string; mode?: DiffMode }) {
  let budget = MAX_LINES;
  return (
    <div className={`diff-viewer diff-${mode}`}>
      {hunks.map((h, hi) => {
        const ops = compactDiffOps(diffOps(h.oldText, h.newText));
        const rows: React.ReactNode[] = [];
        for (let i = 0; i < ops.length; i++) {
          if (budget <= 0) {
            rows.push(
              <div className="diff-line skip" key={`t${hi}`}>
                <span className="diff-gutter">⋯</span>
                <span>Diff truncated</span>
              </div>,
            );
            break;
          }
          const op = ops[i]!;
          if (op.type === "skip") {
            rows.push(
              mode === "split" ? (
                <div className="diff-row skip" key={i}>
                  <div className="diff-side"><span className="diff-gutter">⋯</span><span>{op.count} unchanged</span></div>
                  <div className="diff-side"><span className="diff-gutter">⋯</span><span>{op.count} unchanged</span></div>
                </div>
              ) : (
                <div className="diff-line skip" key={i}>
                  <span className="diff-gutter">⋯</span>
                  <span>{op.count} unchanged lines</span>
                </div>
              ),
            );
            continue;
          }
          budget--;
          if (mode === "split") {
            // Old side shows context+deletions; new side shows context+additions.
            const oldCell = op.type === "add" ? null : op.text || " ";
            const newCell = op.type === "del" ? null : op.text || " ";
            rows.push(
              <div className="diff-row" key={i}>
                <div className={`diff-side ${op.type === "del" ? "del" : op.type === "ctx" ? "" : "empty"}`}>
                  {oldCell !== null && <><span className="diff-gutter">{op.type === "del" ? "−" : " "}</span><span className="diff-code">{oldCell}</span></>}
                </div>
                <div className={`diff-side ${op.type === "add" ? "add" : op.type === "ctx" ? "" : "empty"}`}>
                  {newCell !== null && <><span className="diff-gutter">{op.type === "add" ? "+" : " "}</span><span className="diff-code">{newCell}</span></>}
                </div>
              </div>,
            );
            continue;
          }
          const gutter = op.type === "add" ? "+" : op.type === "del" ? "−" : " ";
          rows.push(
            <div className={`diff-line ${op.type}`} key={i}>
              <span className="diff-gutter">{gutter}</span>
              <span className="diff-code">{op.text || " "}</span>
            </div>,
          );
        }
        const title = hunks.length > 1 ? `Hunk ${hi + 1}` : h.label || single || "Diff";
        return (
          <div className="diff-hunk" key={hi}>
            <div className="diff-hunk-title">
              <span>{title}</span>
              <DiffStat added={h.added} removed={h.removed} />
            </div>
            {rows}
          </div>
        );
      })}
    </div>
  );
});
