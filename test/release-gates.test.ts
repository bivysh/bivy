// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";

const release = parse(readFileSync(".github/workflows/release.yml", "utf8"));

test("production cannot publish without canonical full CI on the release commit", () => {
  const gate = release.jobs["production-ci"];
  assert.equal(gate.uses, "./.github/workflows/ci.yml");
  assert.equal(gate.needs, "plan");
  // Full CI runs here unless CI on this exact SHA already produced a receipt.
  assert.equal(gate.if, "needs.plan.outputs.tested != 'true'");
  assert.equal(gate.with.force_all, true);
  assert.equal(gate.permissions["pull-requests"], "read");

  const production = release.jobs.production;
  assert.deepEqual(production.needs, ["plan", "production-ci"]);
  // No bare always(): failed/cancelled dependencies must skip publication, and
  // a skipped CI gate is only acceptable when the plan proved it redundant.
  assert.doesNotMatch(production.if, /always\(\)/);
  assert.match(production.if, /^!cancelled\(\)/);
  assert.match(production.if, /needs\.plan\.result == 'success'/);
  assert.match(
    production.if,
    /needs\.production-ci\.result == 'success'\s*\|\| \(needs\.production-ci\.result == 'skipped' && needs\.plan\.outputs\.tested == 'true'\)/,
  );
  // Only a pushed v* tag (or a retry from one) plans a promotion.
  assert.equal(release.jobs.plan.if, "startsWith(github.ref, 'refs/tags/v')");
});

test("the CI reuse check only accepts a merge-queue run or one where every job succeeded", () => {
  const plan = release.jobs.plan.steps.find((step: { id?: string }) => step.id === "plan").run as string;
  assert.match(plan, /head_sha=\$sha&status=success/);
  assert.match(plan, /= merge_group \]/);
  assert.match(plan, /select\(\.conclusion != "success"\)/);
  // The tag must name package.json's version on a commit that is on main.
  assert.match(plan, /\[ "\$TAG" = "v\$version" \]/);
  assert.match(plan, /merge-base --is-ancestor "\$sha" origin\/main/);
});
