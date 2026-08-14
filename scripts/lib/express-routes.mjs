// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

/**
 * Extract literal Express route declarations from a composition root.
 *
 * Route paths are deliberately required to be string literals in server.ts so
 * collisions remain statically inspectable. Feature routers may use their own
 * local paths; this guard covers the flat node API assembled by server.ts.
 */
const EXPRESS_ROUTE_CALL = /\bapp\.(get|post|put|patch|delete|options|head)\(/g;

export function expressRouteCallCount(source) {
  return [...source.matchAll(EXPRESS_ROUTE_CALL)].length;
}

export function expressRoutes(source) {
  const route = /\bapp\.(get|post|put|patch|delete|options|head)\(\s*(["'])([^"']+)\2/g;
  const routes = [];
  let match;
  while ((match = route.exec(source))) {
    routes.push({
      method: match[1].toUpperCase(),
      path: match[3],
      line: source.slice(0, match.index).split("\n").length,
    });
  }
  return routes;
}

/** Group declarations that would compete for the same Express method/path. */
export function duplicateExpressRoutes(routes) {
  const byKey = new Map();
  for (const route of routes) {
    const key = `${route.method} ${route.path}`;
    const declarations = byKey.get(key) ?? [];
    declarations.push(route);
    byKey.set(key, declarations);
  }
  return [...byKey.entries()]
    .filter(([, declarations]) => declarations.length > 1)
    .map(([key, declarations]) => ({ key, declarations }));
}
