// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";

const release = parse(readFileSync(".github/workflows/release.yml", "utf8"));
const ci = parse(readFileSync(".github/workflows/ci.yml", "utf8"));

test("production cannot publish without canonical full CI on the release ref", () => {
  const gate = release.jobs["production-ci"];
  assert.equal(gate.uses, "./.github/workflows/ci.yml");
  assert.equal(gate.if, "github.event_name == 'workflow_dispatch'");
  assert.equal(gate.with.force_all, true);
  assert.equal(gate.permissions["pull-requests"], "read");
  assert.equal(release.jobs.production.needs, "production-ci");
  // No always() override: failed/cancelled dependencies must skip publication.
  assert.equal(release.jobs.production.if, "github.event_name == 'workflow_dispatch'");
  assert.equal(release.jobs.production.environment, "release");
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
