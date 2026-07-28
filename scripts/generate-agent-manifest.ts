// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
//
// Regenerate bin/agent-manifest.json from CLI_AGENT_SPECS (the single source of
// truth in src/runtime/index.ts). The plain-JS terminal CLI (bin/bivy.mjs) can't
// import the TypeScript runtime, so it reads this committed JSON instead. A unit
// test (test/agent-manifest-sync.test.ts) asserts the file matches the specs, so
// forgetting to run this after editing a spec fails CI rather than shipping drift.
//
//   npm run gen:agent-manifest
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cliAgentManifest } from "../src/runtime/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "bin", "agent-manifest.json");
const json = JSON.stringify({ agents: cliAgentManifest() }, null, 2) + "\n";
writeFileSync(out, json);
console.log(`Wrote ${path.relative(root, out)} (${cliAgentManifest().length} agents)`);
