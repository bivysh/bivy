// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useCallback, useState } from "react";
import { useMediaQuery } from "./useMediaQuery.js";

export type SidePaneTabId = "changes" | "apps" | "artifacts" | "terminal";

/** Wide enough for the sidebar, a readable chat column and the pane together. */
export const SIDE_PANE_QUERY = "(min-width: 1200px)";
const STORAGE_KEY = "bivy.sidePane";
const TABS: ReadonlySet<string> = new Set<SidePaneTabId>(["changes", "apps", "artifacts", "terminal"]);

function readTab(): SidePaneTabId | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored && TABS.has(stored) ? stored as SidePaneTabId : null;
  } catch { return null; }
}

/**
 * Where a session surface opens: docked in the side pane on a wide screen,
 * or (`show` returns false) as the caller's sheet everywhere else. The open
 * tab is remembered across sessions and reloads; closing it is remembered too.
 */
export function useSidePane() {
  const wide = useMediaQuery(SIDE_PANE_QUERY);
  const [tab, setTabState] = useState<SidePaneTabId | null>(readTab);
  const setTab = useCallback((next: SidePaneTabId | null) => {
    setTabState(next);
    try {
      if (next) localStorage.setItem(STORAGE_KEY, next);
      else localStorage.removeItem(STORAGE_KEY);
    } catch { /* storage unavailable: the pane still works for this page */ }
  }, []);
  /** Opens `next` in the pane when there is room; false means use a sheet. */
  const show = useCallback((next: SidePaneTabId) => {
    if (!wide) return false;
    setTab(next);
    return true;
  }, [wide, setTab]);
  return { wide, tab, setTab, show };
}
