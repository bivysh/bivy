#!/usr/bin/env node
// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
/**
 * Production audit gate with a narrow, documented allowlist.
 *
 * Equivalent to `npm audit --omit=dev --audit-level=high`, except that a small
 * set of advisories we have explicitly reviewed and accepted are ignored. Any
 * OTHER high/critical advisory still fails the build, and any allowlisted entry
 * that npm no longer reports is flagged as stale so the list can't rot.
 *
 * The allowlist is deliberately keyed by GHSA id, scoped with a reason and a
 * review date. Keep it tiny; each entry is a standing risk-acceptance.
 */
import { execFileSync } from "node:child_process";

// GHSA id -> why it is accepted. Revisit on or before `review`.
const ALLOW = {
  // undici is a *direct dependency of @earendil-works/pi-coding-agent*, pinned to
  // 8.5.0 inside that package's published npm-shrinkwrap.json. npm `overrides`
  // cannot move a shrinkwrapped direct dependency, and pi-coding-agent's latest
  // release (0.83.0) still pins 8.5.0, so there is no upstream fix yet. Both
  // advisories concern undici acting as an HTTP proxy/cache; here it is only the
  // coding agent's outbound LLM client. Remove these the moment pi-coding-agent
  // ships undici >= 8.9.0 (or an override becomes effective).
  "GHSA-8xcm-r25x-g524": { pkg: "undici", reason: "shrinkwrapped in pi-coding-agent; no upstream fix", review: "2026-09-03" },
  "GHSA-4cwx-7wf7-3272": { pkg: "undici", reason: "shrinkwrapped in pi-coding-agent; no upstream fix", review: "2026-09-03" },
};

const BLOCKING = new Set(["high", "critical"]);

function ghsaFromUrl(url) {
  const m = typeof url === "string" && url.match(/GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/i);
  return m ? m[0] : undefined;
}

let report;
try {
  const out = execFileSync("npm", ["audit", "--omit=dev", "--json"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  report = JSON.parse(out);
} catch (err) {
  // `npm audit` exits non-zero when vulnerabilities exist; the JSON is still on
  // stdout. Only a genuinely unparseable result is a hard error.
  if (err.stdout) {
    try {
      report = JSON.parse(err.stdout);
    } catch {
      console.error("Could not parse `npm audit --json` output.");
      console.error(err.stdout || err.message);
      process.exit(2);
    }
  } else {
    console.error("Failed to run `npm audit`.");
    console.error(err.message);
    process.exit(2);
  }
}

const blocking = new Map(); // GHSA -> { pkg, title }
const seenAllowed = new Set();

for (const [name, v] of Object.entries(report.vulnerabilities || {})) {
  for (const via of v.via || []) {
    if (typeof via !== "object") continue; // string = a package name, not an advisory
    if (!BLOCKING.has(via.severity)) continue;
    const ghsa = ghsaFromUrl(via.url);
    if (ghsa && ALLOW[ghsa]) {
      seenAllowed.add(ghsa);
      continue;
    }
    const key = ghsa || `${via.source || via.title}`;
    blocking.set(key, { pkg: via.name || name, title: via.title });
  }
}

// Report what we ignored, and warn on stale allowlist entries.
for (const [ghsa, meta] of Object.entries(ALLOW)) {
  if (seenAllowed.has(ghsa)) {
    console.log(`ignored (allowlisted): ${ghsa} — ${meta.pkg}: ${meta.reason} (review ${meta.review})`);
  } else {
    console.log(`note: allowlisted ${ghsa} (${meta.pkg}) no longer reported — remove it from scripts/audit-prod.mjs`);
  }
}

if (blocking.size > 0) {
  console.error(`\n${blocking.size} high/critical advisory(ies) not on the allowlist:`);
  for (const [ghsa, info] of blocking) {
    console.error(`  - ${ghsa}  ${info.pkg}: ${info.title}`);
  }
  console.error("\nFix them, or (only after review) add the GHSA id to the allowlist in scripts/audit-prod.mjs.");
  process.exit(1);
}

console.log("\nProduction audit clean (no high/critical advisories outside the allowlist).");
