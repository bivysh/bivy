// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// bin/agent-manifest.json is the serialized bridge that lets the plain-JS terminal
// CLI (bin/bivy.mjs) share the SAME agent list as the TypeScript runtime's
// AGENT_PROFILES, without importing TS. This test asserts the committed JSON is in
// sync with the specs, so editing a spec without running `npm run gen:agent-manifest`
// fails CI instead of silently drifting the two surfaces apart.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cliAgentManifest } from "../src/runtime/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = path.join(root, "bin", "agent-manifest.json");

assert.ok(fs.existsSync(file), "bin/agent-manifest.json must exist (run: npm run gen:agent-manifest)");

const onDisk = fs.readFileSync(file, "utf8");
const expected = JSON.stringify({ agents: cliAgentManifest() }, null, 2) + "\n";
assert.equal(
  onDisk,
  expected,
  "bin/agent-manifest.json is stale — regenerate it with `npm run gen:agent-manifest` after changing AGENT_PROFILES.",
);

// The manifest must carry every CLI agent, with the fields bin/bivy.mjs relies on.
const manifest = cliAgentManifest();
assert.ok(manifest.length >= 19, `expected all CLI agents in the manifest, got ${manifest.length}`);
for (const a of manifest) {
  assert.ok(a.id && a.label && a.command, `manifest entry ${a.id} must carry id/label/command`);
  assert.equal(typeof a.hidden, "boolean", `${a.id} must declare hidden`);
  assert.ok(Array.isArray(a.headlessFlags), `${a.id} must carry headlessFlags`);
  // No unfilled template tokens leak into the terminal's headless-detection list.
  for (const f of a.headlessFlags) assert.ok(!f.includes("{"), `${a.id} headlessFlags must not contain a template token: ${f}`);
}

// Spot-check the identity of a couple of agents whose binary differs from their id.
const byId = Object.fromEntries(manifest.map((a) => [a.id, a]));
assert.equal(byId.continue.command, "cn", "Continue's binary is `cn`");
assert.equal(byId.kilocode.command, "kilo", "Kilo Code's binary is `kilo`");
assert.equal(byId.rovodev.command, "acli", "Rovo Dev's binary is `acli`");
assert.equal(byId.rovodev.install, null, "Rovo Dev installs out of band (no install descriptor)");
assert.equal(byId.codebuff.hidden, true, "Codebuff is hidden");

console.log("agent-manifest-sync: all tests passed");
