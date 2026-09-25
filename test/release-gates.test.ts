// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";

const release = parse(readFileSync(".github/workflows/release.yml", "utf8"));
const ci = parse(readFileSync(".github/workflows/ci.yml", "utf8"));

test("production cannot publish without canonical full CI on the release commit", () => {
  const gate = release.jobs["production-ci"];
  assert.equal(gate.uses, "./.github/workflows/ci.yml");
  assert.equal(gate.needs, "plan");
  // Full CI runs here unless a CI run on this exact SHA already passed every job.
  assert.equal(gate.if, "needs.plan.outputs.release == 'true' && needs.plan.outputs.tested != 'true'");
  assert.equal(gate.with.force_all, true);
  assert.equal(gate.permissions["pull-requests"], "read");

  const production = release.jobs.production;
  assert.deepEqual(production.needs, ["plan", "staging", "production-ci"]);
  // No bare always(): failed/cancelled dependencies must skip publication, and
  // a skipped CI gate is only acceptable when the plan proved it redundant.
  assert.doesNotMatch(production.if, /always\(\)/);
  assert.match(production.if, /^!cancelled\(\)/);
  assert.match(production.if, /needs\.plan\.outputs\.release == 'true'/);
  assert.match(production.if, /needs\.staging\.result == 'success'/);
  assert.match(
    production.if,
    /needs\.production-ci\.result == 'success'\s*\|\| \(needs\.production-ci\.result == 'skipped' && needs\.plan\.outputs\.tested == 'true'\)/,
  );
  assert.equal(production.environment, "release");
});

test("the CI reuse check only accepts a run where every job succeeded", () => {
  const plan = release.jobs.plan.steps.find((step: { id?: string }) => step.id === "plan").run as string;
  assert.match(plan, /head_sha=\$GITHUB_SHA&status=success/);
  assert.match(plan, /select\(\.conclusion != "success"\)/);
});

test("every path-filtered CI job can be forced for a production release", () => {
  assert.equal(ci.on.workflow_call.inputs.force_all.type, "boolean");
  for (const [name, job] of Object.entries(ci.jobs) as [string, { if?: string }][]) {
    if (job.if?.includes("needs.changes.outputs")) {
      assert.match(job.if, /^inputs\.force_all \|\| /, `${name} would skip release verification`);
      assert.ok(ci.jobs["ci-ok"].needs.includes(name), `${name} is absent from the required gate`);
    }
  }
});
