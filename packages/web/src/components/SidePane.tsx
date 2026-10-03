// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { CloseIcon } from "./UiIcons.js";

export type SidePaneTab<T extends string> = { id: T; label: string; count?: number };

/**
 * The session's side pane on a wide screen: what the agent changed, made and
 * is running, beside the chat instead of over it. Tabs are data; the body is
 * whatever the parent renders for the active tab (the same component that is
 * a sheet on a phone, see Panel).
 */
export function SidePane<T extends string>({ tabs, active, onSelect, onClose, children }: {
  tabs: ReadonlyArray<SidePaneTab<T>>;
  active: T;
  onSelect: (id: T) => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  // Arrow keys move between tabs (WAI-ARIA tabs pattern, automatic activation).
  const onKeyDown = (event: KeyboardEvent, index: number) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = (index + step + tabs.length) % tabs.length;
    const tab = tabs[next];
    if (!tab) return;
    onSelect(tab.id);
    refs.current[next]?.focus();
  };
  return (
    <aside className="side-pane" aria-label="Session details">
      <div className="side-pane-head">
        <div className="segmented side-pane-tabs" role="tablist" aria-label="Session details">
          {tabs.map((tab, index) => (
            <button
              key={tab.id}
              ref={(el) => { refs.current[index] = el; }}
              type="button"
              role="tab"
              id={`side-pane-tab-${tab.id}`}
              aria-controls="side-pane-body"
              aria-selected={active === tab.id}
              tabIndex={active === tab.id ? 0 : -1}
              className="seg-btn side-pane-tab"
              onClick={() => onSelect(tab.id)}
              onKeyDown={(event) => onKeyDown(event, index)}
            >
              {tab.label}
              {tab.count ? <span className="side-pane-count">{tab.count}</span> : null}
            </button>
          ))}
        </div>
        <button type="button" className="btn ghost icon side-pane-close" onClick={onClose} aria-label="Hide side pane" title="Hide side pane">
          <CloseIcon size={18} />
        </button>
      </div>
      <div className="side-pane-body" id="side-pane-body" role="tabpanel" aria-labelledby={`side-pane-tab-${active}`}>
        {children}
      </div>
    </aside>
  );
}
