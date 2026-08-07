// SPDX-License-Identifier: AGPL-3.0-only
// Reactive URL-backed state for the Automations destination (`/automations`).
// Automations is a first-class surface reached from the sidebar foot, but like
// Settings it overlays whichever session route sits behind it rather than
// replacing it — the controller's routing (router.ts, AppController#applyRoute)
// ignores `automations` routes so the active session never changes just because
// Automations opened. This module owns only the "is Automations open" half,
// exposed as a subscribe/getSnapshot pair for useSyncExternalStore.

import { navigate, parseRoute, type Route } from "./router.js";

export type AutomationsRouteState = boolean; // true = open

const listeners = new Set<() => void>();
function notify(): void {
  for (const fn of listeners) fn();
}

function fromRoute(route: Route): AutomationsRouteState {
  return route.kind === "automations";
}

let cached: AutomationsRouteState = fromRoute(parseRoute());

if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => {
    cached = fromRoute(parseRoute());
    notify();
  });
}

export function subscribeAutomationsRoute(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getAutomationsRoute(): AutomationsRouteState {
  return cached;
}

/** Open Automations — pushes one history entry so hardware/browser Back closes
 *  it (see closeAutomations). */
export function openAutomations(): void {
  navigate({ kind: "automations" });
  cached = true;
  notify();
}

/** Close Automations back to whichever route sits behind it (the caller computes
 *  it — usually the active session, or a fresh draft). openAutomations always
 *  pushes exactly one entry, so replacing it resolves in one step. */
export function closeAutomations(underlying: Route): void {
  navigate(underlying, { replace: true });
  cached = false;
  notify();
}
