// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { memo, useState } from "react";
import type { PlanEntry, PlanStatus } from "@bivy/core";
import { ChevronRightIcon } from "./UiIcons.js";

const STATUS_LABEL: Record<PlanStatus, string> = {
  completed: "Done",
  in_progress: "In progress",
  pending: "To do",
  cancelled: "Cancelled",
};

/**
 * The agent's plan (todo list) as of the last update in a turn: one work-line
 * with progress that expands into the checklist. Open while steps remain, folded
 * once every step is settled; the reader can toggle either way.
 */
export const PlanCard = memo(function PlanCard({ plan }: { plan: PlanEntry[] }) {
  const settled = plan.filter((e) => e.status === "completed" || e.status === "cancelled").length;
  const done = plan.filter((e) => e.status === "completed").length;
  const current = plan.find((e) => e.status === "in_progress");
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open = toggled ?? settled < plan.length;
  const summary = `${done} of ${plan.length} done${current && !open ? ` · ${current.text}` : ""}`;
  return (
    <div className="tool-group plan-card">
      <button className="tool-group-line" onClick={() => setToggled(!open)} aria-expanded={open}>
        <span className="tool-group-label">Plan</span>
        <span className="tool-group-summary">{summary}</span>
        <span className="tool-chevron plan-chevron"><ChevronRightIcon size={14} /></span>
      </button>
      {open && (
        <ol className="plan-steps">
          {plan.map((entry, index) => (
            <li key={entry.id ?? index} className={`plan-step is-${entry.status}`}>
              <span className="plan-mark" aria-hidden />
              <span className="plan-text">{entry.text}</span>
              <span className="sr-only">, {STATUS_LABEL[entry.status]}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
});
