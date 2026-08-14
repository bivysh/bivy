// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import fs from "node:fs";

const server = fs.readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
const cli = fs.readFileSync(new URL("../bin/bivy.mjs", import.meta.url), "utf8");

// --- server: the route is registered, behind the same auth boundary as the
// other node-summary endpoints, and backed by the capabilities controller ---

const authMiddlewareIndex = server.indexOf('app.use("/api", authMiddleware(identity))');
const capabilitiesRouteIndex = server.indexOf('app.get("/api/capabilities"');
assert.ok(authMiddlewareIndex > 0, "auth middleware wiring must exist");
assert.ok(capabilitiesRouteIndex > 0, "node exposes GET /api/capabilities");
assert.ok(
  capabilitiesRouteIndex > authMiddlewareIndex,
  "/api/capabilities must be registered after authMiddleware, so it is not accidentally reachable unauthenticated",
);
assert.match(server, /capabilitiesController\.getCapabilities\(\)/, "the route delegates to the capabilities controller");
assert.match(server, /createCapabilitiesController\(/, "server.ts wires the capabilities controller from its canonical stores");

// The controller's fact adapters must come from the existing canonical
// stores, not a fresh scan (no new registries, no unbounded enumeration).
assert.match(server, /listRuntimes\(\)\.map\(\(runtime\)/, "agent facts come from the existing agent registry");
assert.match(server, /createCredentialVault\(credsDir, piDir\)\.list\(\)/, "provider facts come from the existing credential vault, not a new key scan");
assert.match(server, /localModelSummaries\(\)\)/, "local endpoint facts come from the existing local-model registry, not an active port probe");
assert.match(server, /\.filter\(\(provider\) => provider\.availableOnThisMachine\)/, "a Machine-scoped local endpoint synced from another Machine must not inflate this Machine's inventory");
assert.match(server, /listInstalledPlugins\(appDir\)\.map\(\(plugin\)/, "plugin facts come from the existing plugin store");
assert.match(server, /loadSavedWorkspaces\(\)\.length/, "workspace count is a bound (.length), not a path enumeration");

// --- CLI: `bivy capabilities [--json]` fetches the same endpoint -----------

assert.match(cli, /case "capabilities":/, "bivy capabilities is a registered command");
assert.match(cli, /async function cmdCapabilities/, "cmdCapabilities is implemented");
assert.match(cli, /localApi\(config, "\/api\/capabilities"\)/, "the CLI fetches the authenticated local capabilities endpoint");
assert.match(cli, /const json = args\.includes\("--json"\)/, "cmdCapabilities supports --json");
assert.match(cli, /"available"[\s\S]{0,80}"unavailable"[\s\S]{0,80}"unknown"|state === "unavailable"/, "human rendering distinguishes available/unavailable/unknown honestly");
assert.doesNotMatch(
  cli.slice(cli.indexOf("async function cmdCapabilities"), cli.indexOf("async function cmdDoctor")),
  /online|offline/i,
  "capability states must never be phrased as connection status (online/offline)",
);

console.log("capabilities API + CLI contract: passed");
