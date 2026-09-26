// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Reactive URL-backed state for the sidebar's Artifacts and Apps pages
// (`/artifacts`, `/apps`). Like Automations, they overlay whichever session sits
// behind them — the controller's applyRoute ignores `library` routes, so opening
// one never changes the active session.

import { navigate, parseRoute, type LibraryView, type Route } from "./router.js";

const listeners = new Set<() => void>();
function notify(): void {
  for (const fn of listeners) fn();
}

function fromRoute(route: Route): LibraryView | null {
  return route.kind === "library" ? route.view : null;
}

let cached: LibraryView | null = fromRoute(parseRoute());

if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => {
    cached = fromRoute(parseRoute());
    notify();
  });
}

export function subscribeLibraryRoute(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The open page, or null when neither is open. */
export function getLibraryRoute(): LibraryView | null {
  return cached;
}

/** Open a page. Switching between the two replaces, so Back always returns to
 *  what was behind the first one. */
export function openLibrary(view: LibraryView): void {
  navigate({ kind: "library", view }, { replace: cached !== null });
  cached = view;
  notify();
}

/** Close back to the route behind it (the caller computes it — usually the
 *  active session, or a fresh draft). */
export function closeLibrary(underlying: Route): void {
  navigate(underlying, { replace: true });
  cached = null;
  notify();
}
