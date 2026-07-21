// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
// Lightweight, dependency-free client routing for the session shell.
//
// Two real routes drive the app:
//   /sessions/new     — a fresh draft (nothing created on the node yet)
//   /sessions/:id      — an open session
// Anything else (notably `/`) is treated as the "root" home, which renders the
// same empty/first-run shell a fresh draft does. Keeping this in one small
// module means the controller owns *when* to navigate while the URL parsing and
// history writes stay in one testable place.

export type Route =
  | { kind: "session"; id: string }
  | { kind: "new" }
  | { kind: "root" };

const SESSION_PATH = /^\/sessions\/([^/]+)\/?$/;

/** Parse the current (or a given) pathname into a Route. */
export function parseRoute(pathname: string = location.pathname): Route {
  const match = SESSION_PATH.exec(pathname);
  if (match && match[1]) {
    const id = decodeURIComponent(match[1]);
    // `/sessions/new` is the draft route, not a session whose id is "new".
    if (id === "new") return { kind: "new" };
    return { kind: "session", id };
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
