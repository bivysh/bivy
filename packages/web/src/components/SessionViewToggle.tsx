// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useRef, type KeyboardEvent } from "react";
import { SESSION_VIEWS, type SessionView } from "../sessionView.js";
import { ChatBubbleIcon, TerminalIcon } from "./UiIcons.js";

const ICONS: Record<SessionView, typeof TerminalIcon> = { chat: ChatBubbleIcon, terminal: TerminalIcon };

/**
 * Chat | Terminal switch for the open session, on the line under its title: a
 * radiogroup (like Segmented.tsx) on the canonical `.segmented` / `.seg-btn`
 * control, so arrow keys move the choice. Labels hide on narrow screens so the
 * machine name beside it keeps room; aria-label keeps the accessible name.
 */
export function SessionViewToggle({ value, onChange }: { value: SessionView; onChange: (view: SessionView) => void }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKeyDown = (event: KeyboardEvent, index: number) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = (index + step + SESSION_VIEWS.length) % SESSION_VIEWS.length;
    const view = SESSION_VIEWS[next];
    if (!view) return;
    onChange(view.id);
    refs.current[next]?.focus();
  };
  return (
    <div className="segmented session-view-toggle" role="radiogroup" aria-label="Session view">
      {SESSION_VIEWS.map((view, index) => (
        <button
          key={view.id}
          ref={(el) => { refs.current[index] = el; }}
          type="button"
          role="radio"
          className="seg-btn"
          aria-checked={value === view.id}
          tabIndex={value === view.id ? 0 : -1}
          onClick={() => onChange(view.id)}
          onKeyDown={(event) => onKeyDown(event, index)}
          aria-label={view.label}
          title={view.label}
        >
          {(() => { const Icon = ICONS[view.id]; return <Icon size={14} aria-hidden="true" />; })()}
          <span className="session-view-label">{view.label}</span>
        </button>
      ))}
    </div>
  );
}
