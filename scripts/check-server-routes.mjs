#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { duplicateExpressRoutes, expressRouteCallCount, expressRoutes } from "./lib/express-routes.mjs";

const serverUrl = new URL("../src/server.ts", import.meta.url);
const source = readFileSync(serverUrl, "utf8");
const routes = expressRoutes(source);
const callCount = expressRouteCallCount(source);
const duplicates = duplicateExpressRoutes(routes);

if (routes.length !== callCount) {
  console.error(
    `Found ${callCount} Express route calls but only ${routes.length} literal paths in src/server.ts. ` +
      "Declare route paths as string literals so collisions remain inspectable.",
  );
  process.exit(1);
}

if (duplicates.length) {
  console.error("Duplicate Express routes in src/server.ts:");
  for (const duplicate of duplicates) {
    const locations = duplicate.declarations
      .map((route) => `${fileURLToPath(serverUrl)}:${route.line}`)
      .join(", ");
    console.error(`  ${duplicate.key}: ${locations}`);
  }
  console.error("Express uses the first matching handler, so later declarations are unreachable.");
  process.exit(1);
}

console.log(`✓ ${routes.length} Express routes have unique method/path pairs.`);
