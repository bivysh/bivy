#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Architectural fitness check: fail when a module imports across a forbidden
// boundary. This is the enforcement spine for the modular architecture.
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
    // The rule is architectural: no runtime/, agents/, session/, server, or
    // secrets. Pi-freeness falls out of that — Pi lives under runtime/ (pi-oauth)
    // and agents/pi/, both already covered — EXCEPT native-pi.ts, the one Pi
    // module at src root, so it is the only Pi path named explicitly. e2e.ts
    // (AES-256-GCM crypto leaf) is intentionally NOT forbidden: Layer B (store.ts)
    // may use it; the Sealer port abstracts it for a future browser build.
    forbid: ["../runtime/", "../agents/", "../session/", "../server", "../secrets", "../native-pi"],
    // The Pi provider-catalog listing is the one sanctioned consumer-side bridge
    // (runtime/provider-catalog.ts wires Pi's list into the Pi-free api.ts). The
    // facade re-exports it; allow that single specifier.
    allow: ["../runtime/provider-catalog.js"],
    // Pilot boundary (Phase 1) — two-layer split landed, boundary enforced.
    enforce: true,
    note: "credentials must be a pure domain + injected-port service; upward deps become ports (see pilot spec).",
  },
  {
    name: "controllers-dont-import-server",
    dir: "src/controllers",
    forbid: ["../server", "./server"],
    enforce: true,
    note: "controllers are imported BY server.ts; the dependency direction is server -> controller only (Phase 2).",
  },
  {
    name: "protocol-is-a-pure-contract",
    dir: "src/protocol",
    forbid: ["../server", "../runtime/", "../agents/", "../session/", "../credentials/", "../controllers/"],
    enforce: true,
    note: "the protocol layer is the wire contract — it may use typebox but imports no implementation; every transport/consumer depends on IT.",
  },
  {
    name: "remote-does-not-import-server",
    dir: "src/remote",
    forbid: ["../server", "./server"],
    enforce: true,
    note: "the remote module is imported BY the kernel via ./remote/index.js; it never imports server.ts (the composition root). Direction: server -> remote only (Phase 3).",
  },
  {
    name: "audit-is-a-leaf",
    dir: "src/audit",
    forbid: ["../server", "../runtime/", "../agents/", "../session/", "../credentials/", "../controllers/", "../harness/"],
    enforce: true,
    note: "the audit trail is a pure fs leaf; the daemon hands it decisions to record. It imports no kernel implementation (moat #1).",
  },
  {
    name: "ephemeral-lifecycle-is-pure-data",
    dir: "packages/core/src/ephemeral-lifecycle.ts",
    forbid: ["./", "../", "node:", "@"],
    enforce: true,
    note: "ephemeral lifecycle projections are data-in/data-out and import no storage, provider, transport, browser, or clock implementation.",
  },
  {
    name: "followup-queue-is-a-pure-reducer",
    dir: "packages/core/src/followup-queue.ts",
    forbid: ["./store", "./transport", "./account", "./local-store", "node:", "react"],
    enforce: true,
    note: "follow-up commands reduce immutable queue values; the SessionStore is only an identity/subscription shell.",
  },
  {
    name: "ephemeral-catalog-is-pure-data",
    dir: "packages/core/src/ephemeral-catalog.ts",
    forbid: ["./", "../", "node:", "@"],
    enforce: true,
    note: "provider identity and capability facts are standalone data, not adapter behavior.",
  },
  {
    name: "ephemeral-machine-is-a-value",
    dir: "packages/core/src/ephemeral-machine.ts",
    forbid: ["./ephemeral-storage", "./ephemeral-provider", "./transport", "./account", "node:", "react"],
    enforce: true,
    note: "provider-neutral machine facts depend only on other value projections.",
  },
  {
    name: "ephemeral-launch-plan-is-a-pure-decision",
    dir: "packages/core/src/ephemeral-launch-plan.ts",
    forbid: ["./ephemeral-storage", "./ephemeral-provider-adapters", "./ephemeral.js", "./transport", "./local-store", "node:", "react"],
    enforce: true,
    note: "launch planning combines supplied facts into intent data; orchestration interprets the plan at the effect edge.",
  },
  {
    name: "ephemeral-provider-ports-dont-import-effects",
    dir: "packages/core/src/ephemeral-provider-ports.ts",
    forbid: ["./ephemeral-storage", "./ephemeral-provider-adapters", "./ephemeral.js", "./transport", "./local-store"],
    enforce: true,
    note: "provider contracts depend on values; adapter and persistence implementations depend on the contracts.",
  },
  {
    name: "ephemeral-storage-does-not-import-providers",
    dir: "packages/core/src/ephemeral-storage.ts",
    forbid: ["./ephemeral-provider", "./ephemeral.js", "./transport", "./local-store"],
    enforce: true,
    note: "device persistence composes value modules without knowing provider implementations or orchestration.",
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
  if (fs.statSync(abs).isFile()) return /\.(ts|tsx|mts|mjs|js)$/.test(abs) ? [dir] : out;
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
      if (rule.allow?.some((a) => spec === a || spec.includes(a))) continue;
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
  console.error("\nModule boundary check failed.");
  process.exit(1);
}
