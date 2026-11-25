// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
//
// Reopen where you left off. A phone may end an installed app soon after it is
// backgrounded; it then relaunches at the start URL (`/`), dropping you on a new
// draft instead of the chat you were in. The app notes the chat it was hidden on
// and, on a launch at `/` soon after, opens that chat again.

import type { Route } from "./router.js";

/** How long after leaving a launch still counts as coming back. */
export const RESUME_WINDOW_MS = 60 * 60 * 1000;

export interface LastPlace {
  /** The session that was on screen. */
  sessionId: string;
  /** The machine it lives on, so a launch can switch to it first. */
  nodeId?: string;
  /** When the app was hidden (ms since epoch). */
  at: number;
}

/** The chat to reopen for a launch on `route`, if any. Only a bare launch
 *  (`/`) of an installed app resumes: a link, a reload or a browser tab already
 *  says where it wants to be. */
export function placeToResume(route: Route, place: LastPlace | null, now: number, standalone: boolean): LastPlace | null {
  if (!standalone || route.kind !== "root" || !place) return null;
  const age = now - place.at;
  return age >= 0 && age <= RESUME_WINDOW_MS ? place : null;
}

const KEY = "bivy.lastPlace";

export function readLastPlace(): LastPlace | null {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<LastPlace> | null;
    if (!value || typeof value.sessionId !== "string" || !value.sessionId || typeof value.at !== "number") return null;
    return { sessionId: value.sessionId, nodeId: typeof value.nodeId === "string" ? value.nodeId : undefined, at: value.at };
  } catch {
    return null;
  }
}

/** Record the place the app is leaving; `null` (a draft, or nothing open)
 *  forgets it, so leaving from a new chat launches into a new chat. */
export function writeLastPlace(place: LastPlace | null): void {
  try {
    if (place) localStorage.setItem(KEY, JSON.stringify(place));
    else localStorage.removeItem(KEY);
  } catch {
    // Storage unavailable (private mode): resuming is a convenience.
  }
}
