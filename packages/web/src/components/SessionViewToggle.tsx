// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useRef, type KeyboardEvent } from "react";
import type { SessionView } from "../sessionView.js";
import { ChatBubbleIcon, DiffIcon, TerminalIcon } from "./UiIcons.js";

/** What the session's main column shows. Chat and Terminal are remembered per
 *  session (sessionView.ts); Changes is a look at what the agent changed, on
 *  screens too narrow for the side pane. */
export type SessionPaneView = SessionView | "changes";

const VIEWS: Record<SessionPaneView, { label: string; Icon: typeof TerminalIcon }> = {
  chat: { label: "Chat", Icon: ChatBubbleIcon },
  terminal: { label: "Terminal", Icon: TerminalIcon },
  changes: { label: "Changes", Icon: DiffIcon },
};

/**
 * One switch for the open session's main column, on the line under its title:
 * a radiogroup (like Segmented.tsx) on the canonical `.segmented` / `.seg-btn`
 * control, so arrow keys move the choice. `views` lists what this session can
 * show, in order. Labels hide on narrow screens so the machine name beside it
 * keeps room; aria-label keeps the accessible name, and Changes keeps its count.
 */
export function SessionViewToggle({ views, value, onChange, changes = 0 }: {
  views: ReadonlyArray<SessionPaneView>;
  value: SessionPaneView;
  onChange: (view: SessionPaneView) => void;
  /** Files changed this session, shown on Changes. */
  changes?: number;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKeyDown = (event: KeyboardEvent, index: number) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = (index + step + views.length) % views.length;
    const view = views[next];
    if (!view) return;
    onChange(view);
    refs.current[next]?.focus();
  };
  return (
    <div className="segmented session-view-toggle" role="radiogroup" aria-label="Session view">
      {views.map((id, index) => {
        const { label, Icon } = VIEWS[id];
        const count = id === "changes" && changes > 0 ? changes : null;
        return (
          <button
            key={id}
            ref={(el) => { refs.current[index] = el; }}
            type="button"
            role="radio"
            className="seg-btn"
            aria-checked={value === id}
            tabIndex={value === id ? 0 : -1}
            onClick={() => onChange(id)}
            onKeyDown={(event) => onKeyDown(event, index)}
            aria-label={count ? `${label}, ${count} file${count === 1 ? "" : "s"}` : label}
            title={label}
          >
            <Icon size={14} aria-hidden="true" />
            <span className="session-view-label">{label}</span>
            {count && <span className="seg-count" aria-hidden="true">{count}</span>}
          </button>
        );
      })}
    </div>
  );
}
