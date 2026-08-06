// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Reactive URL-backed state for the Settings overlay (#78: make Settings
// router/url based). Settings is an overlay on top of whichever session route
// is behind it, not a replacement for it — the controller's own routing
// (router.ts, AppController#applyRoute) keeps ignoring `settings` routes so the
// active session never changes just because Settings opened. This module owns
// only the "is Settings open, and on which section" half, exposed the same way
// the session store is (a subscribe/getSnapshot pair for useSyncExternalStore).

import { navigate, parseRoute, type Route, type SettingsView } from "./router.js";

export type SettingsRouteState = { view: SettingsView | null } | null; // null = closed

const listeners = new Set<() => void>();
function notify(): void {
  for (const fn of listeners) fn();
}

function fromRoute(route: Route): SettingsRouteState {
  return route.kind === "settings" ? { view: route.view } : null;
}

let cached: SettingsRouteState = fromRoute(parseRoute());

// Back/forward navigation (and any other code that changes the URL directly)
// needs to be reflected here too, same as the controller's own popstate hook.
if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => {
    cached = fromRoute(parseRoute());
    notify();
  });
}

export function subscribeSettingsRoute(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getSettingsRoute(): SettingsRouteState {
  return cached;
}

/** Open Settings, optionally straight to a section — pushes one history entry
 *  so the hardware/browser Back button closes it (see closeSettings). */
export function openSettings(view: SettingsView | null = null): void {
  navigate({ kind: "settings", view });
  cached = { view };
  notify();
}

/** Switch the active section in place — nav clicks, the mobile "‹ Settings"
 *  back-to-menu button, and cross-panel links (GitHub App ↔ GitHub Queue).
 *  Replaces rather than pushes, so Settings is never more than one history
 *  entry deep regardless of how many sections were visited. */
export function setSettingsView(view: SettingsView | null): void {
  navigate({ kind: "settings", view }, { replace: true });
  cached = { view };
  notify();
}

/** Close Settings back to whichever route sits behind it. Since openSettings
 *  always pushes exactly one entry and setSettingsView only ever replaces it,
 *  Settings is never more than one entry deep, so replacing it with the real
 *  underlying route (the caller's job to compute — usually the active session,
 *  or a fresh draft) always resolves in one step. */
export function closeSettings(underlying: Route): void {
  navigate(underlying, { replace: true });
  cached = null;
  notify();
}
