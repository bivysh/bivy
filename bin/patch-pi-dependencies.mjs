#!/usr/bin/env node
// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
/**
 * pi-coding-agent 0.82.1 publishes an npm-shrinkwrap that pins the vulnerable
 * brace-expansion 5.0.7 below its own node_modules. npm overrides update the
 * outer lockfile/audit result but do not replace the shrinkwrapped files during
 * installation. Replace that one nested package with our direct, exact 5.0.9
 * dependency until pi publishes a corrected shrinkwrap.
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

const source = findDependency("brace-expansion");
const piPackage = findDependency(path.join("@earendil-works", "pi-coding-agent"));
const target = piPackage && path.join(piPackage, "node_modules", "brace-expansion");

if (!target || !fs.existsSync(target)) process.exit(0);
if (!source) throw new Error("Security patch source brace-expansion@5.0.9 is missing");

const sourcePackage = JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8"));
if (sourcePackage.version !== "5.0.9") {
  throw new Error(`Refusing dependency patch from unexpected brace-expansion ${sourcePackage.version}`);
}

fs.rmSync(target, { recursive: true, force: true });
fs.cpSync(source, target, { recursive: true });
console.log("Patched pi-coding-agent's nested brace-expansion to 5.0.9");
