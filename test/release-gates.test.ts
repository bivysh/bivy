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

test("a full-tier CI run executes every job, so the release plan can reuse it", () => {
  // The plan reuses a run only when no job concluded other than success; a
  // job that a full-tier run skips would force full CI again before every release.
  for (const [name, job] of Object.entries(ci.jobs) as [string, { if?: string }][]) {
    if (!job.if || job.if === "${{ always() }}") continue;
    assert.match(job.if, /^needs\.changes\.outputs\.tier == 'full'( \|\| |$)/, `${name} is skipped in a full run`);
  }
  // Queued release commits run the full tier, which is what the plan reuses.
  const tierStep = ci.jobs.changes.steps.find((step: { id?: string }) => step.id === "tier");
  assert.match(tierStep.run, /\$QUEUE_BASE:package\.json/);
  assert.match(tierStep.run, /\|\| \[ "\$release" = true \]; then\n\s*tier=full/);
});

test("every path-filtered CI job runs in the full tier that a production release forces", () => {
  assert.equal(ci.on.workflow_call.inputs.force_all.type, "boolean");
  const tierStep = ci.jobs.changes.steps.find((step: { id?: string }) => step.id === "tier");
  assert.equal(tierStep.env.FORCE_ALL, "${{ inputs.force_all }}");
  assert.match(tierStep.run, /if \[ "\$FORCE_ALL" = true \] \|\|[^\n]*\n\s*tier=full/);
  for (const [name, job] of Object.entries(ci.jobs) as [string, { if?: string }][]) {
    if (job.if?.includes("needs.changes.outputs")) {
      assert.match(job.if, /^needs\.changes\.outputs\.tier == 'full'( \|\| |$)/, `${name} would skip release verification`);
      assert.ok(ci.jobs["ci-ok"].needs.includes(name), `${name} is absent from the required gate`);
    }
  }
});

test("the full tier runs every unit and core suite; only pr/queue select by change", () => {
  // The nightly and release runs are the only complete runs once the queue is
  // change-selected, so selection must never leak into the full tier.
  const steps = ci.jobs.checks.steps as { name?: string; run?: string }[];
  for (const name of ["Unit tests", "Core tests"]) {
    const run = steps.find((step) => step.name === name)?.run ?? "";
    assert.match(run, /if \[ "\$TIER" != full \]; then/, `${name} must select by change only outside the full tier`);
  }
});
