#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Audits the licenses of every installed third-party dependency.
//
// The root project installs with pnpm, whose lockfile records no license data at
// all, so the root audit walks the INSTALLED tree and reads each package.json.
// That is strictly better than reading a lockfile: it audits the bytes that are
// actually on disk. It does require `pnpm install` to have run first.
//
// services/relay and services/control-plane are separate npm projects with their
// own package-lock.json, and npm's lockfile does carry `license`, so those keep
// the cheaper lockfile-based path (no install needed).
import fs from "node:fs";
import path from "node:path";

const npmLockfiles = [
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
const isExemptPackage = (pkgPath) => exemptScopes.some((scope) => pkgPath.includes(scope));

// khroma 2.1.0 accidentally omits the package.json `license` field, but ships a
// complete MIT `license` file and identifies itself as MIT in its README. Keep
// this exception version-specific so a future package release is audited again.
const knownManifestLicenseOmissions = ["node_modules/.pnpm/khroma@2.1.0/node_modules/khroma/package.json"];
const isKnownManifestLicenseOmission = (pkgPath, license) =>
  !license && knownManifestLicenseOmissions.some((suffix) => pkgPath.replaceAll("\\", "/").endsWith(suffix));

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

function check(source, name, pkgPath, license) {
  if (
    disallowedPattern.test(license) ||
    (!isExemptPackage(pkgPath) && !isKnownManifestLicenseOmission(pkgPath, license) && !licenseLooksAllowed(license))
  ) {
    problems.push(`${source}: ${name} (${pkgPath}) has unsupported or unknown license: ${license || "<missing>"}`);
  }
}

// --- Root project: walk the installed pnpm tree --------------------------------
//
// pnpm materializes every resolved package exactly once under node_modules/.pnpm
// as `<name>@<version>[_<peer-hash>]/node_modules/<name>`, so one pass over that
// directory covers the full dependency graph — including nested copies, which a
// hoisted layout would hide behind a single top-level entry.
const virtualStore = "node_modules/.pnpm";
// Counted by name@version: a store entry's directory also contains links to its
// peers, and a package with several peer resolutions gets one entry per
// combination, so a raw directory count would badly overstate the audit.
const rootPackages = new Set();
if (fs.existsSync(virtualStore)) {
  for (const entry of fs.readdirSync(virtualStore)) {
    if (entry === "node_modules" || entry === ".") continue;
    const inner = path.join(virtualStore, entry, "node_modules");
    if (!fs.existsSync(inner)) continue;
    // <inner>/<name> for an unscoped package, <inner>/@scope/<name> for a scoped
    // one. Anything else at this level is a peer dependency link, not the package
    // this store entry is for — but auditing those too is harmless (they resolve
    // to their own store entry, which we visit on its own iteration).
    for (const scopeOrName of fs.readdirSync(inner)) {
      const dirs = scopeOrName.startsWith("@")
        ? fs.readdirSync(path.join(inner, scopeOrName)).map((n) => path.join(scopeOrName, n))
        : [scopeOrName];
      for (const rel of dirs) {
        const manifest = path.join(inner, rel, "package.json");
        let meta;
        try {
          meta = JSON.parse(fs.readFileSync(manifest, "utf8"));
        } catch {
          continue; // not a package dir (or a dangling link) — skip
        }
        // Bivy's own workspace packages are AGPL and are not third-party.
        if (typeof meta.name === "string" && meta.name.startsWith("@bivy/")) continue;
        const key = `${meta.name ?? rel}@${meta.version ?? "?"}`;
        if (rootPackages.has(key)) continue;
        rootPackages.add(key);
        check("node_modules", meta.name ?? rel, manifest, normalizeLicense(meta.license));
      }
    }
  }
} else {
  console.error(
    "Root dependencies are not installed, so their licenses cannot be audited.\n" +
      "Run `pnpm install` and try again.",
  );
  process.exit(2);
}

// --- Services: npm lockfiles still carry license metadata ----------------------
for (const lockfile of npmLockfiles) {
  const lock = JSON.parse(fs.readFileSync(lockfile, "utf8"));
  for (const [pkgPath, meta] of Object.entries(lock.packages ?? {})) {
    if (!pkgPath || meta.link) continue;
    // First-party workspace packages (the root and anything under a workspace
    // path rather than node_modules/) carry Bivy's own AGPL license, which isn't
    // in the third-party allowlist. Only audit installed dependencies.
    if (!pkgPath.startsWith("node_modules/")) continue;
    check(lockfile, meta.name ?? path.basename(pkgPath), pkgPath, normalizeLicense(meta.license));
  }
}

if (problems.length) {
  console.error("Dependency license audit failed:\n" + problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}

console.log(
  `Dependency license audit passed for ${rootPackages.size} installed root package(s) ` +
    `and ${npmLockfiles.length} service lockfile(s).`,
);
