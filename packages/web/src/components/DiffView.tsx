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

/** Line-by-line diff viewer for Edit/Write hunks, matching the legacy client. */
export const DiffView = memo(function DiffView({ hunks, single }: { hunks: DiffHunk[]; single?: string }) {
  let budget = MAX_LINES;
  return (
    <div className="diff-viewer">
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
              <div className="diff-line skip" key={i}>
                <span className="diff-gutter">⋯</span>
                <span>{op.count} unchanged lines</span>
              </div>,
            );
            continue;
          }
          budget--;
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
