// SPDX-License-Identifier: AGPL-3.0-only
// Reactive URL-backed state for the routable Run detail destination
// (`/runs/:runId`). Like Settings and Automations, a Run detail overlays
// whichever session route sits behind it rather than replacing it — the
// controller's routing (router.ts, AppController#applyRoute) ignores `run`
// routes so the active session never changes just because a Run opened. This
// module owns the "which Run id is open, if any" half so a copied/deep-linked
// `/runs/:runId` URL restores directly on cold load.

import { navigate, parseRoute, type Route } from "./router.js";

/** null = no Run detail open. Otherwise open on the given Run id. */
export type RunRouteState = { runId: string } | null;

const listeners = new Set<() => void>();
function notify(): void {
  for (const fn of listeners) fn();
}

function fromRoute(route: Route): RunRouteState {
  return route.kind === "run" ? { runId: route.id } : null;
}

let cached: RunRouteState = fromRoute(parseRoute());

if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => {
    cached = fromRoute(parseRoute());
    notify();
  });
}

export function subscribeRunRoute(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getRunRoute(): RunRouteState {
  return cached;
}

/** Open a Run detail — pushes one history entry so hardware/browser Back closes
 *  it (see closeRun). */
export function openRun(runId: string): void {
  navigate({ kind: "run", id: runId });
  cached = { runId };
  notify();
}

/** Close the Run detail back to whichever route sits behind it (the caller
 *  computes it — usually the active session, or a fresh draft). openRun always
 *  pushes exactly one entry, so replacing it resolves in one step. */
export function closeRun(underlying: Route): void {
  navigate(underlying, { replace: true });
  cached = null;
  notify();
}
