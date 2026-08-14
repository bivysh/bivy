// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { declarativeRoutes, duplicateExpressRoutes, expressRouteCallCount, expressRoutes } from "../scripts/lib/express-routes.mjs";

const source = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
const commandRoutesSource = readFileSync(new URL("../src/protocol/client-command-routes.ts", import.meta.url), "utf8");
const literalRoutes = expressRoutes(source);
const routes = [...literalRoutes, ...declarativeRoutes(commandRoutesSource)];

function hasRoute(method: string, path: string): boolean {
  return routes.some((route) => route.method === method && route.path === path);
}

test("server routes use inspectable literal paths without shadowing", () => {
  assert.equal(
    literalRoutes.length,
    expressRouteCallCount(source),
    "every Express route path must be a literal that the duplicate guard can inspect",
  );
  assert.deepEqual(
    duplicateExpressRoutes(routes),
    [],
    "a duplicate method/path makes every later Express handler unreachable",
  );
});

test("linked devices and local bearer-token devices are separate resources", () => {
  for (const method of ["GET", "DELETE"]) {
    const suffix = method === "DELETE" ? "/:id" : "";
    assert.equal(hasRoute(method, `/api/devices${suffix}`), true, `${method} linked-device route is present`);
    assert.equal(hasRoute(method, `/api/auth/devices${suffix}`), true, `${method} bearer-token route is present`);
  }
  assert.equal(hasRoute("POST", "/api/auth/devices"), true, "bearer tokens can be created explicitly");
  assert.equal(hasRoute("POST", "/api/devices"), false, "linked-device pairing does not mint a bearer token");
});
