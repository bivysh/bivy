// SPDX-License-Identifier: AGPL-3.0-only
import { useId, useState, type ReactNode } from "react";
import { toolGroupSummary, toolHasError, type ToolActivity } from "@bivy/core";
import { ChevronRightIcon } from "./UiIcons.js";

/**
 * Everything an agent did in one turn, between the prompt and the answer, as a
 * single line. While it works the line says what it is doing (its latest
 * interim message); once done it summarises the turn. Expanding shows the
 * interim messages and tool batches in order, inline; each batch still opens
 * its detail sheet.
 */
export function TurnWork({ tools, note, notes, running, onExpand, children }: {
  tools: ToolActivity[];
  /** The latest interim message, as one line. */
  note?: string;
  /** How many interim messages the work holds. */
  notes: number;
  running: boolean;
  /** Called just before the work opens, so the chat can stop following the
   *  bottom and the line stays put while the details open below it. */
  onExpand?: () => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const hasError = tools.some((tool) => toolHasError(tool.detail));
  const label = running ? "Working" : tools.length ? "Worked" : "Thought";
  const done = [tools.length ? toolGroupSummary(tools) : "", notes ? `${notes} message${notes === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ");
  const summary = running ? note || (tools.length ? toolGroupSummary(tools) : "Thinking…") : done || "Thought it through";
  return (
    <div className={`turn-work${open ? " is-open" : ""}`}>
      <button
        type="button"
        className={`tool-group-line turn-work-line${running ? " is-running" : ""}${hasError ? " is-error" : ""}`}
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => {
          if (!open) onExpand?.();
          setOpen(!open);
        }}
      >
        <span className="tool-group-state" aria-hidden />
        <span className="tool-group-label">{label}</span>
        <span className="tool-group-summary">{summary}</span>
        <span className="tool-chevron turn-work-chevron"><ChevronRightIcon size={14} /></span>
      </button>
      {open && <div className="turn-work-body" id={bodyId}>{children}</div>}
    </div>
  );
}
