// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
import { useCallback, useState } from "react";

/** A user-resizable panel: its bounds and where its width is remembered. */
export type PanelSize = { key: string; min: number; max: number };

export const SIDEBAR_SIZE: PanelSize = { key: "bivy.sidebarWidth", min: 200, max: 480 };
export const SIDE_PANE_SIZE: PanelSize = { key: "bivy.sidePaneWidth", min: 320, max: 960 };

export function clampWidth(size: PanelSize, width: number): number {
  return Math.round(Math.min(size.max, Math.max(size.min, width)));
}

function readWidth(size: PanelSize): number | null {
  try {
    const stored = Number(localStorage.getItem(size.key));
    return stored > 0 ? clampWidth(size, stored) : null;
  } catch { return null; }
}

/**
 * The width the user dragged a panel to, remembered across reloads. Null means
 * "never resized": the stylesheet's default width applies.
 */
export function usePanelWidth(size: PanelSize) {
  const [width, setWidthState] = useState<number | null>(() => readWidth(size));
  const setWidth = useCallback((next: number | null) => {
    const value = next === null ? null : clampWidth(size, next);
    setWidthState(value);
    try {
      if (value === null) localStorage.removeItem(size.key);
      else localStorage.setItem(size.key, String(value));
    } catch { /* storage unavailable: the width still applies for this page */ }
  }, [size]);
  return [width, setWidth] as const;
}
