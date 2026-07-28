// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
// Lightweight, dependency-free client routing for the session shell.
//
// Real routes:
//   /sessions/new         — a fresh draft (nothing created on the node yet)
//   /sessions/:id         — an open session
//   /settings             — the Settings overlay, root menu
//   /settings/:view       — the Settings overlay, on a specific section
// Anything else (notably `/`) is treated as the "root" home, which renders the
// same empty/first-run shell a fresh draft does. Keeping this in one small
// module means the controller owns *when* to navigate while the URL parsing and
// history writes stay in one testable place.
//
// Settings is an overlay, not a replacement for the session behind it — see
// settingsRoute.ts, which layers Settings' open/closed/section state on top of
// this module without disturbing which session is open underneath.

/** Settings' navigable top-level sections — the mobile drill-in list / desktop
 *  nav. Kept here (rather than in Settings.tsx) so the router can validate a
 *  `/settings/:view` path without importing the component module. */
export type SettingsView =
  | "appearance"
  | "notifications"
  | "import"
  | "providers"
  | "models"
  | "voice"
  | "github"
  | "queue"
  | "automations"
  | "webhooks"
  | "rulesets"
  | "nodes"
  | "ephemeral"
  | "account"
  | "link";

const SETTINGS_VIEWS: readonly SettingsView[] = [
  "appearance",
  "notifications",
  "import",
  "providers",
  "models",
  "voice",
  "github",
  "queue",
  "automations",
  "webhooks",
  "rulesets",
  "nodes",
  "ephemeral",
  "account",
  "link",
];

function isSettingsView(v: string): v is SettingsView {
  return (SETTINGS_VIEWS as readonly string[]).includes(v);
}

export type Route =
  | { kind: "session"; id: string }
  | { kind: "new" }
  | { kind: "settings"; view: SettingsView | null }
  | { kind: "root" };

const SESSION_PATH = /^\/sessions\/([^/]+)\/?$/;
const SETTINGS_PATH = /^\/settings(?:\/([^/]+))?\/?$/;

/** Parse the current (or a given) pathname into a Route. */
export function parseRoute(pathname: string = location.pathname): Route {
  const sessionMatch = SESSION_PATH.exec(pathname);
  if (sessionMatch && sessionMatch[1]) {
    const id = decodeURIComponent(sessionMatch[1]);
    // `/sessions/new` is the draft route, not a session whose id is "new".
    if (id === "new") return { kind: "new" };
    return { kind: "session", id };
  }
  const settingsMatch = SETTINGS_PATH.exec(pathname);
  if (settingsMatch) {
    const raw = settingsMatch[1] ? decodeURIComponent(settingsMatch[1]) : "";
    return { kind: "settings", view: isSettingsView(raw) ? raw : null };
  }
  return { kind: "root" };
}

/**
 * Build the path for a route, preserving the current query string and hash.
 * Those carry mode-critical state — `?local=1&bootstrap=…` for a direct-mode
 * node, and the `#<payload>` a sign-in/QR link lands with — so a copied URL or a
 * reload must keep them intact.
 */
export function routePath(route: Route): string {
  const base =
    route.kind === "session"
      ? `/sessions/${encodeURIComponent(route.id)}`
      : route.kind === "new"
        ? "/sessions/new"
        : route.kind === "settings"
          ? route.view
            ? `/settings/${route.view}`
            : "/settings"
          : "/";
  return base + location.search + location.hash;
}

/**
 * Reflect a route in the address bar. Defaults to a history push (so Back
 * returns to the previous session); pass `replace` for redirects that shouldn't
 * add a history entry. A no-op when the URL already matches, which lets the
 * controller call this unconditionally from openSession/newSession without
 * worrying about duplicate history entries when the change originated from a
 * popstate or the initial deep link.
 */
export function navigate(route: Route, opts: { replace?: boolean } = {}): void {
  const next = routePath(route);
  const current = location.pathname + location.search + location.hash;
  if (next === current) return;
  if (opts.replace) history.replaceState(null, "", next);
  else history.pushState(null, "", next);
}
