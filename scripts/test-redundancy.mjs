#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Find unit suites whose code coverage is fully covered by other suites.
//
//   TEST_COVERAGE_DIR=.coverage/suites node scripts/run-tests.mjs > .coverage/run.log
//   node scripts/test-redundancy.mjs .coverage/suites .coverage/run.log > report.md
//
// Works on raw V8 block coverage (NODE_V8_COVERAGE, children included), keyed
// by script URL and byte range. tsx emits the same code for a file in every
// process, so ranges are comparable across suites without source maps.
//
// Greedy and order-dependent by design: visit suites from most to least
// expensive and drop one when every byte it covers is still covered by the
// suites that remain. The union coverage of the kept set equals the original.
// Coverage says code ran, not that its result was asserted, so the output is a
// review list, not an automatic deletion.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [coverageDir, runLog] = process.argv.slice(2);
if (!coverageDir) {
  process.stderr.write("usage: test-redundancy.mjs <coverage-dir> [run-log]\n");
  process.exit(2);
}

// Repo code under test: not tests, fixtures or dependencies.
function codeFile(url) {
  if (!url.startsWith("file://")) return null;
  const rel = path.relative(repoRoot, fileURLToPath(url.split("?")[0]));
  if (rel.startsWith("..") || /(^|\/)(node_modules|test|dist)\//.test(rel)) return null;
  return rel;
}

// Suite wall-clock from the runner's "── ✓ name (n/N, 12.3s)" lines.
function durations(log) {
  const out = new Map();
  if (!log) return out;
  for (const [, name, secs] of readFileSync(log, "utf8").matchAll(/^── [✓✗] (\S+) \(\d+\/\d+, ([\d.]+)s\)/gm)) {
    out.set(name, Number(secs));
  }
  return out;
}

// Covered byte intervals per file for one suite, unioned over its processes.
// Inner ranges override outer ones, so paint outer-first.
function suiteCoverage(dir) {
  const files = new Map();
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;
    let data;
    try {
      data = JSON.parse(readFileSync(path.join(dir, entry), "utf8"));
    } catch {
      continue;
    }
    for (const script of data.result ?? []) {
      const file = codeFile(script.url);
      if (!file) continue;
      const ranges = script.functions.flatMap((fn) => fn.ranges);
      ranges.sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
      const size = ranges.reduce((max, r) => Math.max(max, r.endOffset), 0);
      let bits = files.get(file);
      if (!bits || bits.length < size) {
        const grown = new Uint8Array(size);
        if (bits) grown.set(bits);
        files.set(file, (bits = grown));
      }
      const painted = new Uint8Array(size);
      for (const r of ranges) painted.fill(r.count > 0 ? 1 : 0, r.startOffset, r.endOffset);
      for (let i = 0; i < size; i++) bits[i] |= painted[i];
    }
  }
  return files;
}

const suites = readdirSync(coverageDir).sort();
const cost = durations(runLog);
const coverage = new Map();
const counts = new Map();
for (const suite of suites) {
  const files = suiteCoverage(path.join(coverageDir, suite));
  coverage.set(suite, files);
  for (const [file, bits] of files) {
    let c = counts.get(file);
    if (!c || c.length < bits.length) {
      const grown = new Uint16Array(bits.length);
      if (c) grown.set(c);
      counts.set(file, (c = grown));
    }
    for (let i = 0; i < bits.length; i++) c[i] += bits[i];
  }
}

const coveredBytes = (files) => [...files.values()].reduce((sum, bits) => sum + bits.reduce((a, b) => a + b, 0), 0);
const uniqueBytes = (files) => {
  let unique = 0;
  for (const [file, bits] of files) {
    const c = counts.get(file);
    for (let i = 0; i < bits.length; i++) if (bits[i] && c[i] === 1) unique++;
  }
  return unique;
};

// Suites that exercise no repo code assert on config, docs or workflow files;
// coverage cannot judge them.
const noCode = suites.filter((suite) => coveredBytes(coverage.get(suite)) === 0);
const initialUnique = new Map(suites.map((suite) => [suite, uniqueBytes(coverage.get(suite))]));
const redundant = [];
for (const suite of [...suites].sort((a, b) => (cost.get(b) ?? 0) - (cost.get(a) ?? 0) || a.localeCompare(b))) {
  if (noCode.includes(suite)) continue;
  const files = coverage.get(suite);
  if (uniqueBytes(files) > 0) continue;
  redundant.push(suite);
  for (const [file, bits] of files) {
    const c = counts.get(file);
    for (let i = 0; i < bits.length; i++) c[i] -= bits[i];
  }
}

// Kept suites whose remaining unique coverage is small: the review question is
// whether those few bytes (listed by file) deserve a whole suite, or a line in
// another one.
const NEAR_BYTES = Number(process.env.NEAR_REDUNDANT_BYTES) || 400;
const uniqueByFile = (files) => {
  const out = [];
  for (const [file, bits] of files) {
    const c = counts.get(file);
    let n = 0;
    for (let i = 0; i < bits.length; i++) if (bits[i] && c[i] === 1) n++;
    if (n) out.push([file, n]);
  }
  return out.sort((a, b) => b[1] - a[1]);
};
const near = suites
  .filter((suite) => !noCode.includes(suite) && !redundant.includes(suite))
  .map((suite) => ({ suite, where: uniqueByFile(coverage.get(suite)) }))
  .map((row) => ({ ...row, unique: row.where.reduce((sum, [, n]) => sum + n, 0) }))
  .filter((row) => row.unique <= NEAR_BYTES)
  .sort((a, b) => (cost.get(b.suite) ?? 0) - (cost.get(a.suite) ?? 0));

const secs = (list) => list.reduce((sum, suite) => sum + (cost.get(suite) ?? 0), 0);
const total = secs(suites);
const fmt = (n) => `${n.toFixed(1)}s`;
const lines = [
  "# Unit-suite coverage redundancy",
  "",
  `${suites.length} suites, ${fmt(total)} summed suite time.`,
  `**${redundant.length} suites (${fmt(secs(redundant))}, ${((100 * secs(redundant)) / (total || 1)).toFixed(0)}%) add no coverage beyond the rest.**`,
  `${noCode.length} suites cover no repo code (config/docs/workflow assertions) and are not judged.`,
  "",
  "## Redundant by coverage (most expensive first)",
  "",
  "| Suite | Time | Covered bytes |",
  "|---|---|---|",
  ...redundant.map((suite) => `| ${suite} | ${fmt(cost.get(suite) ?? 0)} | ${coveredBytes(coverage.get(suite))} |`),
  "",
  `## Near-redundant (≤ ${NEAR_BYTES} unique bytes after the removals above)`,
  "",
  `${near.length} suites, ${fmt(secs(near.map((row) => row.suite)))}.`,
  "",
  "| Suite | Time | Unique bytes | Where |",
  "|---|---|---|---|",
  ...near.map(({ suite, unique, where }) =>
    `| ${suite} | ${fmt(cost.get(suite) ?? 0)} | ${unique} | ${where.slice(0, 3).map(([file, n]) => `${file} (${n})`).join(", ")} |`),
  "",
  "## Not judged (no repo code covered)",
  "",
  ...noCode.map((suite) => `- ${suite} (${fmt(cost.get(suite) ?? 0)})`),
  "",
  "## Most unique coverage (kept)",
  "",
  "| Suite | Unique bytes | Time |",
  "|---|---|---|",
  ...[...initialUnique].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([suite, unique]) => `| ${suite} | ${unique} | ${fmt(cost.get(suite) ?? 0)} |`),
  "",
];
process.stdout.write(lines.join("\n"));
