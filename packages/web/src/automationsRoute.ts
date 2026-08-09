// SPDX-License-Identifier: AGPL-3.0-only
// Reactive URL-backed state for the Automations destination (`/automations`).
// Automations is a first-class surface reached from the sidebar foot, but like
// Settings it overlays whichever session route sits behind it rather than
// replacing it — the controller's routing (router.ts, AppController#applyRoute)
// ignores `automations` routes so the active session never changes just because
// Automations opened. This module owns the "is Automations open" half plus an
// optional one-shot setup focus (open the GitHub/Linear/Slack connection sheet).

import { navigate, parseRoute, type AutomationsSection, type Route } from "./router.js";

/** null = Automations closed. Otherwise open, on the given tab (`section: null`
 *  is the Overview tab). */
export type AutomationsRouteState = { section: AutomationsSection | null } | null;

/** Connection setup sheet to open once Automations mounts (consumed once). */
export type AutomationsSetupFocus = "github" | "linear" | "slack" | "work-queue";

const listeners = new Set<() => void>();
function notify(): void {
  for (const fn of listeners) fn();
}

function fromRoute(route: Route): AutomationsRouteState {
  return route.kind === "automations" ? { section: route.section } : null;
}

let cached: AutomationsRouteState = fromRoute(parseRoute());
/** One-shot: Settings / OAuth return asks Automations to open a connection sheet. */
let pendingSetup: AutomationsSetupFocus | null = null;

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
 *  it (see closeAutomations). Optional `setup` opens the connection sheet once;
 *  optional `section` lands on a specific tab (default Overview). */
export function openAutomations(opts?: { setup?: AutomationsSetupFocus; section?: AutomationsSection | null }): void {
  pendingSetup = opts?.setup ?? null;
  const section = opts?.section ?? null;
  navigate({ kind: "automations", section });
  cached = { section };
  notify();
}

/** Switch the active tab in place (nav clicks) — replaces rather than pushes, so
 *  Automations is never more than one history entry deep regardless of how many
 *  tabs were visited (parity with setSettingsView). */
export function setAutomationsSection(section: AutomationsSection | null): void {
  navigate({ kind: "automations", section }, { replace: true });
  cached = { section };
  notify();
}

/** Read and clear a pending connection-setup focus (call once on Automations mount). */
export function takeAutomationsSetupFocus(): AutomationsSetupFocus | null {
  const next = pendingSetup;
  pendingSetup = null;
  return next;
}

/** Close Automations back to whichever route sits behind it (the caller computes
 *  it — usually the active session, or a fresh draft). openAutomations always
 *  pushes exactly one entry, so replacing it resolves in one step. */
export function closeAutomations(underlying: Route): void {
  navigate(underlying, { replace: true });
  cached = null;
  pendingSetup = null;
  notify();
}
