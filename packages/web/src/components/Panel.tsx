// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import type { ComponentProps } from "react";
import { Sheet, type DismissSheet } from "./Sheet.js";

/** Settle a docked panel's "dismiss": nothing closes, the follow-up still runs. */
const stayOpen: DismissSheet = (afterClose) => afterClose?.();

/**
 * One body, two frames. A session surface (changes, apps, artifacts) is a
 * bottom sheet on a phone, and docks into the side pane on a wide screen.
 * Undocked it is exactly a `Sheet`; docked it keeps the same title and
 * header controls as a toolbar, inline, with no backdrop, focus trap or
 * close button — the side pane owns those.
 */
export function Panel({ docked, ...props }: ComponentProps<typeof Sheet> & { docked?: boolean }) {
  if (!docked) return <Sheet {...props} />;
  const { title, headExtra, children, ariaLabel } = props;
  return (
    <section className="pane-panel" data-size={props.size} aria-label={ariaLabel ?? (typeof title === "string" ? title : undefined)}>
      <div className="pane-panel-head">
        <span className="pane-panel-title">{title}</span>
        {headExtra}
      </div>
      <div className="pane-panel-content">{typeof children === "function" ? children(stayOpen) : children}</div>
    </section>
  );
}
