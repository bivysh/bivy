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

console.log(`✓ ${routes.length} Express routes have unique method/path pairs.`);
