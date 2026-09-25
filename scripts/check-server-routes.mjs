#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { declarativeRoutes, duplicateExpressRoutes, expressRouteCallCount, expressRoutes } from "./lib/express-routes.mjs";

const serverUrl = new URL("../src/server.ts", import.meta.url);
const commandRoutesUrl = new URL("../src/protocol/client-command-routes.ts", import.meta.url);
const source = readFileSync(serverUrl, "utf8");
const commandRoutesSource = readFileSync(commandRoutesUrl, "utf8");
const literalRoutes = expressRoutes(source).map((route) => ({ ...route, source: serverUrl }));
const generatedRoutes = declarativeRoutes(commandRoutesSource).map((route) => ({ ...route, source: commandRoutesUrl }));
const routes = [...literalRoutes, ...generatedRoutes];
const callCount = expressRouteCallCount(source);
const duplicates = duplicateExpressRoutes(routes);

if (literalRoutes.length !== callCount) {
  console.error(
    `Found ${callCount} Express route calls but only ${literalRoutes.length} literal paths in src/server.ts. ` +
      "Declare route paths as string literals so collisions remain inspectable.",
  );
  process.exit(1);
}

if (duplicates.length) {
  console.error("Duplicate Express routes in src/server.ts:");
  for (const duplicate of duplicates) {
    const locations = duplicate.declarations
      .map((route) => `${fileURLToPath(route.source)}:${route.line}`)
      .join(", ");
    console.error(`  ${duplicate.key}: ${locations}`);
  }
  console.error("Express uses the first matching handler, so later declarations are unreachable.");
  process.exit(1);
}

// Express runs middleware in registration order, so an /api route declared
// before the auth middleware is public. Only these may be.
const PUBLIC_API_ROUTES = new Set([
  "GET /api/integrations/oauth/callback",
  "GET /api/git-credential",
  "POST /api/auth/bootstrap",
]);
const authLine = source.split("\n").findIndex((line) => line.includes('app.use("/api", authMiddleware(')) + 1;
if (authLine === 0) {
  console.error('src/server.ts no longer registers app.use("/api", authMiddleware(...)); update this check.');
  process.exit(1);
}
const unauthenticated = literalRoutes.filter((route) =>
  route.line < authLine && route.path.startsWith("/api") && !PUBLIC_API_ROUTES.has(`${route.method} ${route.path}`));
if (unauthenticated.length) {
  console.error(`/api routes registered before the auth middleware (src/server.ts:${authLine}) are public:`);
  for (const route of unauthenticated) console.error(`  ${route.method} ${route.path} (line ${route.line})`);
  console.error("Move them after authMiddleware, or add them to PUBLIC_API_ROUTES if they must be public.");
  process.exit(1);
}

console.log(`✓ ${routes.length} Express routes have unique method/path pairs; only ${PUBLIC_API_ROUTES.size} allowlisted /api routes precede auth.`);
