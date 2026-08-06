#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import fs from "node:fs";
import path from "node:path";

const lockfiles = [
  "package-lock.json",
  "services/relay/package-lock.json",
  "services/control-plane/package-lock.json",
].filter((file) => fs.existsSync(file));

const allowed = new Set([
  "0BSD",
  "Apache-2.0",
  "BSD",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BlueOak-1.0.0",
  "CC-BY-4.0",
  "CC0-1.0",
  "ISC",
  "MIT",
  "MPL-2.0",
  // Non-SPDX free-form string used by a few older packages (e.g. `jsonify`, a
  // transitive dev dep of pg-mem). Public domain is strictly MORE permissive than
  // the already-allowed CC0-1.0 / Unlicense, so it's safe to accept.
  "Public Domain",
  "Python-2.0",
  "Unlicense",
]);

const disallowedPattern = /\b(AGPL|GPL|LGPL|SSPL|BUSL|Commercial|Proprietary)\b/i;

// First-party Anthropic SDK packages declare their license as a free-form
// "SEE LICENSE IN <file>" string rather than an SPDX id, so the allowlist check
// below can't classify them. The actual terms live in the bundled LICENSE.md of
// each package (the `license` field points there, or at README.md for the main
// `@anthropic-ai/claude-agent-sdk` package), and they are proprietary — Anthropic
// PBC, all rights reserved, use governed by Anthropic's commercial terms — not an
// open-source license. That's acceptable here because these are a deliberate,
// trusted runtime dependency resolved from npm at install time; Bivy does not
// redistribute them inside its own published npm artifact. Exempt the scope from
// the unknown-license check while still enforcing the disallowed-license denylist
// above against them.
const exemptScopes = ["@anthropic-ai/"];
const isExemptPackage = (pkgPath) => exemptScopes.some((scope) => pkgPath.includes(`node_modules/${scope}`));

const problems = [];

function normalizeLicense(value) {
  if (!value) return "";
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(normalizeLicense).join(" OR ");
  if (typeof value === "object" && typeof value.type === "string") return value.type.trim();
  return String(value).trim();
}

function licenseLooksAllowed(license) {
  if (!license) return false;
  if (allowed.has(license)) return true;
  if (license.includes(" OR ")) return license.split(/\s+OR\s+/).some((part) => licenseLooksAllowed(part.replace(/[()]/g, "").trim()));
  if (license.includes(" AND ")) return license.split(/\s+AND\s+/).every((part) => licenseLooksAllowed(part.replace(/[()]/g, "").trim()));
  return false;
}

for (const lockfile of lockfiles) {
  const lock = JSON.parse(fs.readFileSync(lockfile, "utf8"));
  for (const [pkgPath, meta] of Object.entries(lock.packages ?? {})) {
    if (!pkgPath || meta.link) continue;
    // First-party workspace packages (the root and anything under a workspace
    // path rather than node_modules/) carry Bivy's own AGPL license, which isn't
    // in the third-party allowlist. Only audit installed dependencies.
    if (!pkgPath.startsWith("node_modules/")) continue;
    const license = normalizeLicense(meta.license);
    const name = meta.name ?? path.basename(pkgPath);
    if (disallowedPattern.test(license) || (!isExemptPackage(pkgPath) && !licenseLooksAllowed(license))) {
      problems.push(`${lockfile}: ${name} (${pkgPath}) has unsupported or unknown license: ${license || "<missing>"}`);
    }
  }
}

if (problems.length) {
  console.error("Dependency license audit failed:\n" + problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}

console.log(`Dependency license audit passed for ${lockfiles.length} lockfile(s).`);
