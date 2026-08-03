#!/usr/bin/env node
// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
/**
 * pi-coding-agent 0.82.1 publishes an npm-shrinkwrap that pins vulnerable
 * transitive packages below its own node_modules. npm overrides update the outer
 * lockfile/audit result but do not replace those shrinkwrapped files during
 * installation. Replace the affected nested packages with direct, exact patched
 * dependencies until pi publishes a corrected shrinkwrap.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// npm-global installs usually nest dependencies under bivy, while npm/npx may
// hoist them to an ancestor node_modules. Support both layouts.
function findDependency(relativePath) {
  let dir = root;
  while (true) {
    const candidate = path.join(dir, "node_modules", relativePath);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

const piPackage = findDependency(path.join("@earendil-works", "pi-coding-agent"));
if (!piPackage) process.exit(0);

const patches = [
  { name: "brace-expansion", version: "5.0.9" },
  { name: "undici", version: "8.9.0" },
];

for (const patch of patches) {
  const source = findDependency(patch.name);
  const target = path.join(piPackage, "node_modules", patch.name);
  if (!fs.existsSync(target)) continue;
  if (!source) throw new Error(`Security patch source ${patch.name}@${patch.version} is missing`);
  const sourcePackage = JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8"));
  if (sourcePackage.version !== patch.version) {
    throw new Error(`Refusing dependency patch from unexpected ${patch.name} ${sourcePackage.version}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(source, target, { recursive: true });
  console.log(`Patched pi-coding-agent's nested ${patch.name} to ${patch.version}`);
}
