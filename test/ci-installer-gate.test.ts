// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { parse } from "yaml";

type Step = { run?: string; if?: string; with?: Record<string, string> };
type Job = { if?: string; needs?: string[] | string; uses?: string; with?: Record<string, unknown>; steps?: Step[] };
const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
const jobs = workflow.jobs as Record<string, Job>;
const filterStep = jobs.changes.steps!.find(step => step.with?.filters)!;
const filters = parse(filterStep.with!.filters);
const patterns = (name: string): string[] => filters[name].flat(Infinity);
const matches = (name: string, file: string) => patterns(name).some(glob => path.matchesGlob(file, glob));

test("installer inputs also trigger the release artifact producer", () => {
  for (const file of [
    ".github/workflows/ci.yml", ".github/workflows/release.yml", "install.sh", ".npmrc",
    "package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml",
    "pnpm-workspace.yaml", "tsconfig.json", "packages/core/package.json",
    "bin/bivy.mjs", "bin/repair-pty-permissions.mjs", "bin/patch-pi-dependencies.mjs",
    "scripts/build-release.mjs", "scripts/release-manifest.mjs", "scripts/smoke-release.mjs",
    "scripts/smoke-pty.mjs", "scripts/smoke-installer.sh", "scripts/installer-smoke-guest.sh",
    "scripts/wait-release-artifact.sh", "test/installer-path.sh",
    "test/installer-smoke-guest.test.ts", "test/ci-installer-gate.test.ts",
  ]) {
    assert.ok(matches("installer", file), `${file} must exercise the installer`);
    assert.ok(matches("root", file), `${file} must produce the artifact the installer waits for`);
  }
});

test("ordinary application changes retain npm consumers without bootstrapping an OS", () => {
  // Includes PR #988, where an unrelated automation change waited for apt.
  for (const file of [
    "src/automation-cli.ts", "src/automation-filter.ts", "src/server.ts",
    "packages/core/src/automation-template.ts", "packages/web/src/components/ChatView.tsx",
    "test/automation-filter.test.ts", "test/control-plane-tasks.test.ts",
  ]) {
    assert.ok(matches("root", file), `${file} must still run npm consumer checks`);
    assert.ok(!matches("installer", file), `${file} must not bootstrap a clean OS`);
  }
  for (const file of ["docs/automations-as-code.md", "services/control-plane/src/index.ts"]) {
    assert.ok(!matches("installer", file));
  }
});

test("installer is required when selected and always runs for force_all releases", () => {
  assert.equal(jobs["installer-smoke"].if, "inputs.force_all || needs.changes.outputs.installer == 'true'");
  for (const name of ["root-release", "release-consumer"]) {
    assert.equal(jobs[name].if, "inputs.force_all || needs.changes.outputs.root == 'true'");
  }
  assert.ok(jobs["ci-ok"].needs?.includes("installer-smoke"));
  assert.match(jobs["ci-ok"].steps![0].run!, /contains\(needs\.\*\.result, 'failure'\)/);
  assert.match(jobs["ci-ok"].steps![0].run!, /contains\(needs\.\*\.result, 'cancelled'\)/);
  const release = parse(readFileSync(".github/workflows/release.yml", "utf8"));
  const gate = Object.values(release.jobs as Record<string, Job>).find(job => job.uses === "./.github/workflows/ci.yml");
  assert.equal(gate?.with?.force_all, true);
});

test("consumer and installer have independent checks, caches, and unconditional guest cleanup", () => {
  const consumer = jobs["release-consumer"].steps!;
  const installer = jobs["installer-smoke"].steps!;
  assert.ok(consumer.some(step => step.run === "node scripts/smoke-release.mjs --artifact release-artifact/bivy-npm.tgz"));
  assert.ok(consumer.every(step => !step.run?.includes("installer-smoke-guest.sh")));
  assert.ok(installer.some(step => step.run === "bash scripts/installer-smoke-guest.sh test"));
  assert.equal(installer.find(step => step.run?.endsWith("installer-smoke-guest.sh cleanup"))?.if, "always()");
  for (const steps of [consumer, installer]) {
    const cache = steps.find(step => step.with?.key)!;
    assert.ok(cache.with!["restore-keys"], "reuse downloads across dependency/installer revisions");
    assert.doesNotMatch(cache.with!.path, /node_modules/);
    assert.ok(steps.some(step => step.with?.name === "release-package"));
  }
});
