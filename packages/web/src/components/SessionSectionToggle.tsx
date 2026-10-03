// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useRef, type KeyboardEvent } from "react";

export type SessionSection = "agent" | "changes";

/**
 * Agent | Changes for the open session on a narrow screen, where there is no
 * side pane: the main column shows either the conversation or what the agent
 * changed, full height. Same radiogroup on `.segmented` / `.seg-btn` as
 * SessionViewToggle, so arrow keys move the choice.
 */
export function SessionSectionToggle({ value, onChange, changes }: {
  value: SessionSection;
  onChange: (section: SessionSection) => void;
  /** Files changed this session, shown on the Changes choice. */
  changes: number;
}) {
  const sections: ReadonlyArray<{ id: SessionSection; label: string; count?: number }> = [
    { id: "agent", label: "Agent" },
    { id: "changes", label: "Changes", count: changes },
  ];
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKeyDown = (event: KeyboardEvent, index: number) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = (index + step + sections.length) % sections.length;
    const section = sections[next];
    if (!section) return;
    onChange(section.id);
    refs.current[next]?.focus();
  };
  return (
    <div className="segmented session-section-toggle" role="radiogroup" aria-label="Show">
      {sections.map((section, index) => (
        <button
          key={section.id}
          ref={(el) => { refs.current[index] = el; }}
          type="button"
          role="radio"
          className="seg-btn"
          aria-checked={value === section.id}
          tabIndex={value === section.id ? 0 : -1}
          onClick={() => onChange(section.id)}
          onKeyDown={(event) => onKeyDown(event, index)}
        >
          {section.label}
          {section.count ? <span className="seg-count">{section.count}</span> : null}
        </button>
      ))}
    </div>
  );
}
