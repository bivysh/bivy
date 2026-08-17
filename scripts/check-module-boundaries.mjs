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
 * specifier string). `allowOnly`, when present, rejects every specifier not in
 * that exact allowlist. `enforce` promotes violations to failures even without
 * the global --enforce flag.
 */
const RULES = [
  {
    name: "session-contract-values-are-dependency-neutral",
    dir: "packages/core/src/session-contract.ts",
    forbid: [""],
    enforce: true,
    note: "session wire values and their pure resolver are the canonical source for node and client builds and import no implementation.",
  },
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
    enforce: true,
    note: "credentials must be a pure domain + injected-port service; upward deps become ports (see pilot spec).",
  },
  {
    name: "agent-profiles-are-declarative-data",
    dir: "src/agents/profiles.ts",
    forbid: ["../runtime", "../harness", "node:", "process", "=>"],
    enforce: true,
    note: "agent definitions are immutable recipes; runtime factories interpret launch and history-loader identities.",
  },
  {
    name: "controllers-dont-import-server",
    dir: "src/controllers",
    forbid: ["../server", "./server"],
    enforce: true,
    note: "controllers are imported BY server.ts; the dependency direction is server -> controller only.",
  },
  {
    name: "device-controller-uses-ports",
    dir: "src/controllers/devices.ts",
    forbid: ["express", "../identity", "../device-registry", "../metadata", "../remote", "../server", "node:"],
    enforce: true,
    note: "device resource semantics depend on injected ports; Express, persistence, relay, and metadata effects stay in the composition root.",
  },
  {
    name: "session-control-controller-uses-ports",
    dir: "src/controllers/session-control.ts",
    forbid: ["express", "../runtime", "../agents", "../session/", "../server", "node:"],
    enforce: true,
    note: "session control operations depend on protocol contracts and injected effects, not daemon/runtime implementation.",
  },
  {
    name: "http-command-adapter-is-transport-only",
    dir: "src/http/client-command-routes.ts",
    forbid: ["../server", "../runtime/", "../agents/", "../session/", "../credentials/", "../controllers/"],
    enforce: true,
    note: "the generated HTTP adapter depends only on Express types and protocol command contracts; feature behavior stays in the canonical registry.",
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
    note: "the remote module is imported BY the kernel via ./remote/index.js; it never imports server.ts (the composition root). Direction: server -> remote only.",
  },
  {
    name: "audit-is-a-leaf",
    dir: "src/audit",
    forbid: ["../server", "../runtime/", "../agents/", "../session/", "../credentials/", "../controllers/", "../harness/"],
    enforce: true,
    note: "the audit trail is a pure fs leaf; the daemon hands it decisions to record. It imports no kernel implementation (moat #1).",
  },
  {
    name: "web-coordinators-are-standalone",
    dir: "packages/web/src/store/coordinators",
    forbid: ["../controller", "react", "ephemeral-provider-adapters", "services/control-plane", "session-contract", "agent-profile"],
    enforce: true,
    note: "coordinators receive effects as explicit dependencies and never reach back into AppController or prohibited implementation modules.",
  },
  {
    name: "ephemeral-lifecycle-is-pure-data",
    dir: "packages/core/src/ephemeral-lifecycle.ts",
    forbid: ["./", "../", "node:", "@"],
    enforce: true,
    note: "ephemeral lifecycle projections are data-in/data-out and import no storage, provider, transport, browser, or clock implementation.",
  },
  {
    name: "session-draft-is-a-pure-reducer",
    dir: "packages/core/src/session-draft.ts",
    forbid: ["./store", "./transport", "./local-store", "node:", "react"],
    enforce: true,
    note: "new-session target choices share one explicit value and are reduced without effects or store identity.",
  },
  {
    name: "followup-queue-is-a-pure-reducer",
    dir: "packages/core/src/followup-queue.ts",
    forbid: ["./store", "./transport", "./account", "./local-store", "node:", "react"],
    enforce: true,
    note: "follow-up commands reduce immutable queue values; the SessionStore is only an identity/subscription shell.",
  },
  ...[
    "connection-event-fold.ts",
    "session-index-event-fold.ts",
    "terminal-event-fold.ts",
    "catalog-settings-event-fold.ts",
    "presentation-event-fold.ts",
  ].map((file) => ({
    name: `${file.replace(/\\.ts$/, "")}-is-pure`,
    dir: `packages/core/src/${file}`,
    forbid: ["./store", "./transport", "./local-store", "./ephemeral", "node:", "react"],
    enforce: true,
    note: "event folds are standalone data transformations; SessionStore installs their returned values.",
  })),
  ...[
    "active-session-event-fold.ts",
    "attention-event-fold.ts",
    "transcript-event-fold.ts",
  ].map((file) => ({
    name: `${file.replace(/\\.ts$/, "")}-is-pure`,
    dir: `packages/core/src/${file}`,
    forbid: ["./store.js", "./transport", "./local-store", "./ephemeral", "session-contract", "agent-profile", "node:", "react"],
    enforce: true,
    note: "active-session folds are standalone immutable decisions; the SessionStore only interprets their patches and commands.",
  })),
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
    name: "ephemeral-launch-plan-is-a-safe-pure-decision",
    dir: "packages/core/src/ephemeral-launch-plan.ts",
    forbid: ["./ephemeral-execution-envelope", "./ephemeral-storage", "./ephemeral-provider-adapters", "./ephemeral.js", "./transport", "./local-store", "BootstrapOpts", "enrollmentToken", "roomKeyB64", "githubToken", "node:", "react"],
    enforce: true,
    note: "inspectable launch plans contain no bootstrap credentials; the execution envelope is separate and effect-edge-only.",
  },
  {
    name: "ephemeral-provider-ports-dont-import-effects",
    dir: "packages/core/src/ephemeral-provider-ports.ts",
    forbid: ["./ephemeral-storage", "./ephemeral-provider-adapters", "./ephemeral.js", "./transport", "./local-store"],
    enforce: true,
    note: "provider contracts depend on values; adapter and persistence implementations depend on the contracts.",
  },
  {
    name: "ephemeral-provider-interpreters-only-depend-downward",
    dir: "packages/core/src/ephemeral-providers",
    allowOnly: [
      "../base64.js",
      "../ephemeral-provider-bootstrap.js",
      "../ephemeral-catalog.js",
      "../ephemeral-lifecycle.js",
      "../ephemeral-machine.js",
      "../ephemeral-provider-ports.js",
      "../ephemeral-provider-utils.js",
    ],
    forbid: [
      "../ephemeral.js",
      "../ephemeral-storage",
      "../ephemeral-launch-plan",
      "../store",
      "../local-store",
      "../transport",
      "../account",
      "node:",
      "react",
    ],
    enforce: true,
    note: "provider interpreters may depend on provider ports, shared provider utilities, and values; never launch orchestration, persistence, stores, or transports.",
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

// @bivy/core compiles the canonical source through this stable package-local
// alias. Requiring identity (not equal copied text) prevents synchronization by
// convention from returning while preserving both packages' existing output
// paths and the root release artifact layout.
const sessionContractAlias = path.join(repoRoot, "src/session/session-contract-values.ts");
const canonicalSessionContract = path.join(repoRoot, "packages/core/src/session-contract.ts");
const contractHasOneSource =
  fs.existsSync(sessionContractAlias) &&
  fs.existsSync(canonicalSessionContract) &&
  fs.realpathSync(sessionContractAlias) === fs.realpathSync(canonicalSessionContract);
console.log(`\n[${contractHasOneSource ? "CLEAN" : "FAIL"}] session-contract-has-one-canonical-source  — ${contractHasOneSource ? 0 : 1} violation(s)`);
console.log("        node and @bivy/core must compile the same dependency-neutral session contract source.");
if (!contractHasOneSource) {
  totalViolations += 1;
  hardFailures += 1;
}

// Compatibility entrypoints must enumerate the API they support. This keeps
// internal interpreter details from leaking accidentally as modules are split.
const explicitFacadeChecks = [
  {
    file: "packages/core/src/ephemeral.ts",
    reject: /export\s*\*/,
    reason: "the ephemeral compatibility facade must use explicit exports",
  },
  {
    file: "packages/core/src/ephemeral-provider-adapters.ts",
    reject: /export\s*\*/,
    reason: "the provider compatibility facade must use explicit exports",
  },
  ...[
    "ephemeral.js",
    "connection-event-fold.js",
    "session-index-event-fold.js",
    "catalog-settings-event-fold.js",
    "presentation-event-fold.js",
    "active-session-event-fold.js",
    "attention-event-fold.js",
    "transcript-event-fold.js",
  ].map((specifier) => ({
    file: "packages/core/src/index.ts",
    reject: new RegExp(`export\\s*\\*\\s*from\\s*["']\\./${specifier.replace(".", "\\.")}["']`),
    reason: `the core entrypoint must explicitly export supported ${specifier} symbols`,
  })),
];
const facadeViolations = explicitFacadeChecks.filter(({ file, reject }) =>
  reject.test(fs.readFileSync(path.join(repoRoot, file), "utf8")),
);
console.log(`\n[${facadeViolations.length ? "FAIL" : "CLEAN"}] core-facades-have-explicit-exports  — ${facadeViolations.length} violation(s)`);
console.log("        touched compatibility facades enumerate their supported exports.");
for (const violation of facadeViolations) console.log(`        ${violation.file}  → ${violation.reason}`);
if (facadeViolations.length) {
  totalViolations += facadeViolations.length;
  hardFailures += facadeViolations.length;
}

for (const rule of RULES) {
  const files = walk(rule.dir);
  const violations = [];
  for (const file of files) {
    const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
    const lines = source.split("\n");
    for (const spec of specifiersOf(source)) {
      if (rule.allow?.some((a) => spec === a || spec.includes(a))) continue;
      const hit = rule.forbid.find((f) => spec.includes(f));
      const outsideAllowlist = rule.allowOnly && !rule.allowOnly.includes(spec);
      if (!hit && !outsideAllowlist) continue;
      // Best-effort line number for the specifier.
      const lineNo = lines.findIndex((l) => l.includes(`"${spec}"`) || l.includes(`'${spec}'`)) + 1;
      violations.push({ file, lineNo, spec, hit: hit || "not in allowOnly" });
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
