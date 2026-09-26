// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import type { ReactNode } from "react";

/** The letter an app's tile shows. */
export function appInitial(name: string): string {
  return name.trim().charAt(0).toUpperCase() || "A";
}

/**
 * One row for an app, a view of it, or a server that could become one — the
 * same tile, type and trailing action in the chat card, the Apps page and the
 * Apps sheet. `small` is for rows nested inside an app (its views).
 */
export function AppRow({ tile, name, meta, detail, action, small = false }: {
  tile: ReactNode;
  name: ReactNode;
  meta?: ReactNode;
  /** Extra line under the meta, e.g. the chat it came from. */
  detail?: ReactNode;
  action?: ReactNode;
  small?: boolean;
}) {
  return (
    <div className={`app-row${small ? " small" : ""}`}>
      <span className="app-tile" aria-hidden>{tile}</span>
      <div className="app-row-text">
        <strong className="app-row-name">{name}</strong>
        {meta && <span className="app-row-meta">{meta}</span>}
        {detail}
      </div>
      {action && <div className="app-row-action">{action}</div>}
    </div>
  );
}
