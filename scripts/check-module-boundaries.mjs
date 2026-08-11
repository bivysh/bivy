#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Architectural fitness check: fail when a module imports across a forbidden
// boundary. This is the enforcement spine for the platform modularization plan
// (docs/internal/platform-modularization-plan.md).
//
// Rules are declarative: each rule names a source glob and a set of import
// specifiers that source is NOT allowed to reach. A module is only as modular
// as the boundary you can mechanically prove it keeps.
//
// Usage:
//   node scripts/check-module-boundaries.mjs            # report baseline, exit 0
//   node scripts/check-module-boundaries.mjs --enforce  # exit 1 on any violation
//
// Flip a rule's `enforce: true` (or pass --enforce globally) once that
// boundary has reached zero violations.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const globalEnforce = process.argv.includes("--enforce");

/**
 * Each rule: files under `dir` (recursively) may not `import`/`export ... from`
 * any specifier matching one of `forbid` (substring match against the raw
 * specifier string). `enforce` promotes this rule's violations to failures even
 * without the global --enforce flag.
 */
const RULES = [
  {
    name: "credentials-is-a-leaf",
    dir: "src/credentials",
    // e2e.ts (AES-256-GCM crypto leaf) is intentionally NOT forbidden: the node
    // service layer (store.ts) may use it, and the Sealer port abstracts it for a
    // future browser build. secrets.ts / oauth / Pi / runtime stay inverted.
    forbid: ["../runtime/", "../agents/", "../session/", "../server", "../secrets", "/pi-oauth", "native-pi"],
    // Pilot boundary (Phase 1). Flip to true once the two-layer split lands.
    enforce: false,
    note: "credentials must be a pure domain + injected-port service; upward deps become ports (see pilot spec).",
  },
];

// Match the `from "spec"` clause of any import/export (including multi-line
// `export {\n ...\n} from "spec"` re-export blocks), plus bare `import "spec"`.
// In module code a `from "…"`/`import "…"` string only appears in these forms.
const FROM_RE = /\bfrom\s*["']([^"']+)["']/g;
const BARE_IMPORT_RE = /(?:^|\n)\s*import\s*["']([^"']+)["']/g;

function walk(dir) {
  const out = [];
  const abs = path.join(repoRoot, dir);
  if (!fs.existsSync(abs)) return out;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(rel));
    else if (/\.(ts|tsx|mts|mjs|js)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) out.push(rel);
  }
  return out;
}

function specifiersOf(source) {
  const specs = [];
  for (const re of [FROM_RE, BARE_IMPORT_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source))) specs.push(m[1]);
  }
  return specs;
}

let totalViolations = 0;
let hardFailures = 0;

for (const rule of RULES) {
  const files = walk(rule.dir);
  const violations = [];
  for (const file of files) {
    const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
    const lines = source.split("\n");
    for (const spec of specifiersOf(source)) {
      const hit = rule.forbid.find((f) => spec.includes(f));
      if (!hit) continue;
      // Best-effort line number for the specifier.
      const lineNo = lines.findIndex((l) => l.includes(`"${spec}"`) || l.includes(`'${spec}'`)) + 1;
      violations.push({ file, lineNo, spec, hit });
    }
  }
  const enforced = globalEnforce || rule.enforce;
  totalViolations += violations.length;
  if (enforced) hardFailures += violations.length;

  const status = violations.length === 0 ? "CLEAN" : enforced ? "FAIL" : "baseline";
  console.log(`\n[${status}] ${rule.name}  (${rule.dir})  — ${violations.length} violation(s)`);
  if (rule.note) console.log(`        ${rule.note}`);
  for (const v of violations) {
    console.log(`        ${v.file}:${v.lineNo || "?"}  →  ${v.spec}   (forbidden: "${v.hit}")`);
  }
}

console.log(`\n${totalViolations} total violation(s); ${hardFailures} enforced.`);
if (hardFailures > 0) {
  console.error("\nModule boundary check failed. See docs/internal/platform-modularization-plan.md.");
  process.exit(1);
}
