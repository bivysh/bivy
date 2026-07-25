// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
//
// Smoke tests for the top-level `bivy` CLI dispatcher (bin/bivy.mjs): the
// version command, unknown-command exit code, and --help. These guard the
// baseline UX contract users expect from a public CLI at 0.1.
import { strict as assert } from "node:assert";
import test from "node:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(repoRoot, "bin", "bivy.mjs");
const pkgVersion = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
).version as string;

function runCli(args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
}

for (const flag of ["version", "--version", "-v"]) {
  test(`\`bivy ${flag}\` prints the package version and exits 0`, () => {
    const r = runCli([flag]);
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
    assert.equal(r.stdout.trim(), pkgVersion);
  });
}

test("an unknown command exits non-zero and names the offending command", () => {
  const r = runCli(["definitely-not-a-command"]);
  assert.notEqual(r.status, 0, "unknown command must exit non-zero");
  assert.match(r.stderr + r.stdout, /Unknown command: definitely-not-a-command/);
});

test("`bivy --help` exits 0 and lists core commands", () => {
  const r = runCli(["--help"]);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
  const out = r.stdout + r.stderr;
  for (const cmd of ["bivy run", "bivy setup", "bivy sessions", "bivy doctor", "bivy version"]) {
    assert.ok(out.includes(cmd), `help should mention "${cmd}"`);
  }
});
