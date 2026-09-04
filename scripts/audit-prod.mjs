#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
/**
 * Production audit gate with a narrow, documented allowlist.
 *
 * Equivalent to `pnpm audit --prod --audit-level=high`, except that a small set
 * of advisories we have explicitly reviewed and accepted are ignored. Any OTHER
 * high/critical advisory still fails the build, and any allowlisted entry that
 * the registry no longer reports is flagged as stale so the list can't rot.
 *
 * The allowlist is deliberately keyed by GHSA id, scoped with a reason and a
 * review date. Keep it tiny; each entry is a standing risk-acceptance.
 *
 * NOTE ON THE REPORT SHAPE: `pnpm audit --json` emits the registry's v1 bulk
 * format — a flat `advisories` map keyed by advisory id — whereas `npm audit
 * --json` emits npm's own v2 format, a `vulnerabilities` map keyed by package
 * name. They are not interchangeable, and reading the wrong key yields an empty
 * result rather than an error, which would turn this gate into a silent no-op.
 * assertKnownShape() below refuses to pass on a report it does not recognise.
 */
import { execFileSync } from "node:child_process";

// GHSA id -> why it is accepted. Revisit on or before `review`.
const ALLOW = {
  // (empty — previous undici advisories in pi-coding-agent are no longer reported
  // after the postinstall patch to undici@8.10.0)
};

const BLOCKING = new Set(["high", "critical"]);

function ghsaFromUrl(url) {
  const m = typeof url === "string" && url.match(/GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/i);
  return m ? m[0] : undefined;
}

const AUDIT_CMD = "pnpm";
// pnpm's audit endpoint is remote infrastructure. Keep the security gate
// strict for advisories, but do not fail every CI run when the registry is
// temporarily unavailable; pnpm documents this flag specifically for CI.
// A malformed/non-audit response is still rejected by assertKnownShape below.
const AUDIT_ARGS = ["audit", "--prod", "--json", "--ignore-registry-errors"];

let report;
let rawOutput = "";
try {
  rawOutput = execFileSync(AUDIT_CMD, AUDIT_ARGS, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  report = JSON.parse(rawOutput);
} catch (err) {
  // The audit exits non-zero when vulnerabilities exist; the JSON is still on
  // stdout. Only a genuinely unparseable result is a hard error.
  const output = String(err.stdout || rawOutput || "");
  if (output) {
    try {
      report = JSON.parse(output);
    } catch {
      // pnpm occasionally prints the registry transport failure as plain text
      // even with --json (for example, "The operation was aborted"). Because
      // registry errors are explicitly ignored for this invocation, recognize
      // only those transport-shaped messages; malformed audit data still fails
      // closed below.
      if (/operation was aborted|timed?\s*out|eai_again|econn(reset|refused)|enotfound|registry.*(error|unavailable)|audit.*(endpoint|service).*failed/i.test(output)) {
        console.warn(`Production audit unavailable: ${output.trim()}`);
        console.warn("Continuing without advisory results; retry the audit when the registry is healthy.");
        process.exit(0);
      }
      console.error(`Could not parse \`${AUDIT_CMD} ${AUDIT_ARGS.join(" ")}\` output.`);
      console.error(output);
      process.exit(2);
    }
  } else {
    console.error(`Failed to run \`${AUDIT_CMD} ${AUDIT_ARGS.join(" ")}\`.`);
    console.error(err.message);
    process.exit(2);
  }
}

/**
 * Refuse to report "clean" from a report we cannot actually read. An empty
 * `advisories` map is a legitimate clean result, but a report missing the key
 * entirely means the tool changed its output format — treat that as a failure,
 * not as zero findings. The dependency count is the second half of that check:
 * auditing nothing also produces no advisories.
 */
function assertKnownShape(r) {
  if (!r || typeof r !== "object" || !r.advisories || typeof r.advisories !== "object") {
    console.error(
      `Unrecognised audit report: expected a v1 \`advisories\` map from \`${AUDIT_CMD} ${AUDIT_ARGS.join(" ")}\`.\n` +
        `Got keys: ${r && typeof r === "object" ? Object.keys(r).join(", ") || "(none)" : typeof r}.\n` +
        "npm's v2 \`vulnerabilities\` shape is NOT compatible — update this script rather than letting the gate pass silently.",
    );
    process.exit(2);
  }
  const total = r.metadata?.totalDependencies;
  if (typeof total !== "number" || total <= 0) {
    console.error(
      `Audit reported ${total ?? "no"} dependencies, so it examined nothing. ` +
        "Run `pnpm install` first, or fix the audit invocation.",
    );
    process.exit(2);
  }
}

// With --ignore-registry-errors pnpm returns a small `{ error }` JSON report
// when the advisory service is unavailable. This is an infrastructure result,
// not a clean audit; warn loudly and let the separate lockfile/pin checks keep
// enforcing the dependency policy. Do not treat arbitrary malformed JSON this
// way — only pnpm's documented registry-error envelope is accepted here.
if (report && typeof report === "object" && report.error && typeof report.error === "object") {
  const error = report.error;
  const code = typeof error.code === "string" ? error.code : "registry error";
  const detail = typeof error.detail === "string" ? error.detail : typeof error.message === "string" ? error.message : "the registry did not return an audit report";
  console.warn(`Production audit unavailable (${code}): ${detail}`);
  console.warn("Continuing without advisory results; retry the audit when the registry is healthy.");
  process.exit(0);
}

assertKnownShape(report);

const blocking = new Map(); // GHSA -> { pkg, title }
const seenAllowed = new Set();

// v1 shape: advisories[<id>] = { severity, title, module_name, url,
// github_advisory_id, ... } — one entry per advisory, already flattened, so
// there is no `via` chain to walk.
for (const [id, advisory] of Object.entries(report.advisories)) {
  if (!BLOCKING.has(advisory.severity)) continue;
  const ghsa = advisory.github_advisory_id || ghsaFromUrl(advisory.url);
  if (ghsa && ALLOW[ghsa]) {
    seenAllowed.add(ghsa);
    continue;
  }
  blocking.set(ghsa || id, { pkg: advisory.module_name || "(unknown)", title: advisory.title });
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
