// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Which view a session shows in the main pane: its chat, or the live agent as its
// interactive terminal (TUI) on the node. Remembered per session for this tab
// (sessionStorage), so a reload
// or coming back to a session lands where you left it. It is not in the URL:
// routePath() carries search/hash across navigations, which would leak one
// session's view into the next.

export type SessionView = "chat" | "terminal";

export const SESSION_VIEWS: ReadonlyArray<{ id: SessionView; label: string }> = [
  { id: "chat", label: "Chat" },
  { id: "terminal", label: "Terminal" },
];

const KEY = "bivy.sessionView";
/** Only non-default choices are stored; keep the map from growing forever. */
const MAX_REMEMBERED = 50;

function readMap(storage: Storage): Record<string, SessionView> {
  try {
    const parsed = JSON.parse(storage.getItem(KEY) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function readSessionView(storage: Storage, sessionId: string | null): SessionView {
  if (!sessionId) return "chat";
  return readMap(storage)[sessionId] === "terminal" ? "terminal" : "chat";
}

export function writeSessionView(storage: Storage, sessionId: string, view: SessionView): void {
  const map = readMap(storage);
  delete map[sessionId];
  if (view !== "chat") map[sessionId] = view;
  const ids = Object.keys(map);
  for (const id of ids.slice(0, Math.max(0, ids.length - MAX_REMEMBERED))) delete map[id];
  try {
    storage.setItem(KEY, JSON.stringify(map));
  } catch {
    /* storage full or unavailable: the choice just isn't remembered */
  }
}
