#!/usr/bin/env node
// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
// Unit-test runner for the node/core suites under test/.
//
// Replaces the old hand-maintained `&&`-chain in package.json, which (a) had to
// be edited by hand for every new test file — so six suites had silently fallen
// out of CI — and (b) halted at the first failure, hiding every later suite's
// result. This auto-discovers `test/*.test.ts`, runs each independently,
// continues past failures, and prints one summary. Exit code is non-zero if any
// suite (ts or the shell installer tests) fails.
import { existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testDir = path.join(repoRoot, "test");
const tsxBin = path.join(repoRoot, "node_modules", ".bin", "tsx");

// Preflight: without tsx every .test.ts suite fails instantly with an opaque
// spawn error, so the summary reads "N/N failed" and hides the real cause. Fail
// loudly with the actual fix instead. (Historically `build:release` could empty
// node_modules and produce exactly this — see issue #11.)
if (!existsSync(tsxBin)) {
  process.stderr.write(
    `\nCannot run tests: ${path.relative(repoRoot, tsxBin)} is missing.\n` +
      `Dependencies are not installed (or were removed). Run \`npm install\` and try again.\n`,
  );
  process.exit(1);
}

const tsSuites = readdirSync(testDir)
  .filter((f) => f.endsWith(".test.ts"))
  .sort()
  .map((f) => ({ name: f, cmd: tsxBin, args: [path.join(testDir, f)] }));

// Shell installer tests (previously the tail of the chain).
const shSuites = ["installer-migration.sh", "installer-path.sh"].map((f) => ({
  name: f,
  cmd: "bash",
  args: [path.join(testDir, f)],
}));

const suites = [...tsSuites, ...shSuites];
const failures = [];
const start = Date.now();

for (const suite of suites) {
  process.stdout.write(`\n── ${suite.name}\n`);
  const result = spawnSync(suite.cmd, suite.args, { cwd: repoRoot, stdio: "inherit" });
  if (result.status !== 0 || result.error) {
    failures.push(suite.name);
  }
}

const elapsed = ((Date.now() - start) / 1000).toFixed(1);
process.stdout.write(`\n${"=".repeat(48)}\n`);
if (failures.length === 0) {
  process.stdout.write(`✓ all ${suites.length} suites passed (${elapsed}s)\n`);
  process.exit(0);
}
process.stdout.write(`✗ ${failures.length}/${suites.length} suite(s) failed (${elapsed}s):\n`);
for (const name of failures) process.stdout.write(`    ${name}\n`);
process.exit(1);
