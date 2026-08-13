#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Verifies the transitive-dependency security pins actually took effect, and
// that the two places they are declared agree.
//
// Background: @earendil-works/pi-coding-agent publishes an npm-shrinkwrap that
// pins vulnerable copies of brace-expansion and undici below its own
// node_modules. npm honours that shrinkwrap, so a published Bivy install needs
// both the `overrides` in package.json AND the bin/patch-pi-dependencies.mjs
// postinstall to physically replace the nested copies. pnpm ignores a
// dependency's shrinkwrap and resolves everything through its own lockfile, so
// in the dev install the bad copies are never created at all and the postinstall
// is a no-op. CI used to assert the patched nested paths existed, which is now
// npm-only and would fail here.
//
// This checks the invariant that actually matters under either layout: no copy
// of an overridden package, anywhere in the installed tree, is off its pin.
//
// It also enforces that package.json `overrides` (read by npm, and the ones that
// resolve the PUBLISHED artifact) and pnpm-workspace.yaml `overrides` (read by
// pnpm, the ones that resolve what we test) express the same pins. Without this
// a pin added to one file would silently miss the other — meaning we'd test a
// tree users never get, or ship a tree we never tested.
import fs from "node:fs";
import path from "node:path";

const problems = [];

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));

/**
 * Flatten npm's override format into `selector -> version`, matching pnpm's
 * `parent>child` spelling: npm nests a parent's overrides as an object, pnpm
 * uses a `>`-joined selector string.
 */
function flattenNpmOverrides(overrides, parent = "") {
  const out = {};
  for (const [name, value] of Object.entries(overrides ?? {})) {
    const selector = parent ? `${parent}>${name}` : name;
    if (value && typeof value === "object") Object.assign(out, flattenNpmOverrides(value, selector));
    else out[selector] = String(value);
  }
  return out;
}

/**
 * Minimal reader for the `overrides:` block of pnpm-workspace.yaml. Deliberately
 * not a YAML dependency: this runs in CI before anything is guaranteed installed,
 * and the block is a flat map of quoted-or-bare keys to scalar versions.
 */
function readPnpmOverrides(file) {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const out = {};
  let inBlock = false;
  for (const line of lines) {
    if (/^overrides:\s*$/.test(line)) {
      inBlock = true;
      continue;
    }
    if (!inBlock) continue;
    if (/^\S/.test(line)) break; // dedent ends the block
    const m = line.match(/^\s+(?:"([^"]+)"|'([^']+)'|([^\s:#][^:]*?))\s*:\s*(?:"([^"]*)"|'([^']*)'|(\S+))\s*$/);
    if (m) out[m[1] ?? m[2] ?? m[3]] = m[4] ?? m[5] ?? m[6];
  }
  return out;
}

const npmOverrides = flattenNpmOverrides(pkg.overrides);
const pnpmOverrides = readPnpmOverrides("pnpm-workspace.yaml");

for (const [selector, version] of Object.entries(npmOverrides)) {
  if (!(selector in pnpmOverrides)) {
    problems.push(`pnpm-workspace.yaml is missing the override "${selector}": ${version} declared in package.json`);
  } else if (pnpmOverrides[selector] !== version) {
    problems.push(`override "${selector}" disagrees: package.json pins ${version}, pnpm-workspace.yaml pins ${pnpmOverrides[selector]}`);
  }
}
for (const selector of Object.keys(pnpmOverrides)) {
  if (!(selector in npmOverrides)) {
    problems.push(`package.json is missing the override "${selector}" declared in pnpm-workspace.yaml (the published artifact would not get it)`);
  }
}

// The pinned version for a bare package name; `parent>child` selectors pin the
// same package, so fold them into the same expectation.
const expected = new Map();
for (const [selector, version] of Object.entries(npmOverrides)) {
  expected.set(selector.split(">").pop(), version);
}

// Walk every materialized package in pnpm's virtual store and flag any copy of a
// pinned package that is not at its pinned version. This catches both a missing
// override and a nested copy that slipped past one.
const virtualStore = "node_modules/.pnpm";
if (!fs.existsSync(virtualStore)) {
  console.error("Dependencies are not installed. Run `pnpm install` and try again.");
  process.exit(2);
}

const seen = new Map(); // name -> Set of versions found
const visited = new Set(); // realpaths, so sideways peer links cannot cycle

function visit(dir) {
  let real;
  try {
    real = fs.realpathSync(dir);
  } catch {
    return;
  }
  if (visited.has(real)) return;
  visited.add(real);

  let entries;
  try {
    entries = fs.readdirSync(real, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    const p = path.join(real, e.name);
    // A scope dir (@scope/) or a node_modules/ only ever contains more entries.
    // pnpm's store dirs are named `@scope+name@version`, which also start with
    // "@" and likewise just contain a node_modules — same treatment either way.
    if (e.name === "node_modules" || e.name.startsWith("@")) {
      visit(p);
      continue;
    }
    // A store entry (`name@version/`) has no package.json of its own — the real
    // package sits under its node_modules. So a failed read here is normal and
    // must NOT skip the recursion below, or every top-level store entry goes
    // unexamined and only packages reachable via a peer link get checked.
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(p, "package.json"), "utf8"));
      if (typeof meta.name === "string" && expected.has(meta.name)) {
        if (!seen.has(meta.name)) seen.set(meta.name, new Set());
        seen.get(meta.name).add(meta.version);
      }
    } catch {
      // not a package dir — keep walking
    }
    visit(path.join(p, "node_modules"));
  }
}
visit(virtualStore);

for (const [name, version] of expected) {
  const found = seen.get(name);
  if (!found) continue; // the pin covers a package this tree doesn't pull in
  const stray = [...found].filter((v) => v !== version);
  if (stray.length) {
    problems.push(`${name} is pinned to ${version} but the installed tree also contains: ${stray.join(", ")}`);
  }
}

if (problems.length) {
  console.error("Security pin check failed:\n" + problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}

const verified = [...expected.keys()].filter((n) => seen.has(n));
console.log(
  `Security pins verified: ${Object.keys(npmOverrides).length} override(s) in sync across package.json and ` +
    `pnpm-workspace.yaml; installed copies of ${verified.join(", ") || "(none present)"} all on their pinned version.`,
);
