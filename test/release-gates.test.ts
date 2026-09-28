// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";

const release = parse(readFileSync(".github/workflows/release.yml", "utf8"));
const production = release.jobs.production;
const step = (name: string) => production.steps.find((s: { name?: string }) => s.name === name).run as string;

test("only a v* tag promotes, and only a commit on main whose package.json names that version", () => {
  assert.equal(production.if, "startsWith(github.ref, 'refs/tags/v')");
  const validate = step("Validate the release tag");
  assert.match(validate, /\[ "\$TAG" = "v\$version" \]/);
  assert.match(validate, /merge-base --is-ancestor "\$sha" origin\/main/);
});

test("production cannot publish without a CI receipt for the exact commit", () => {
  const steps = production.steps.map((s: { name?: string }) => s.name);
  // The receipt gates the irreversible publish.
  assert.ok(steps.indexOf("Require a CI receipt for this commit") < steps.findIndex((n: string) => n?.startsWith("Publish or resume npm")));
  const receipt = step("Require a CI receipt for this commit");
  assert.match(receipt, /head_sha=\$RELEASE_SHA&\$1/);
  // A merge-queue run, or a run where every job passed, is a receipt...
  assert.match(receipt, /= merge_group \]/);
  assert.match(receipt, /select\(\.conclusion != "success"\)/);
  // ...otherwise the full CI tier runs on the tag and must succeed.
  assert.match(receipt, /gh workflow run ci\.yml --ref "\$TAG"/);
  assert.match(receipt, /success\) echo "Full CI run/);
  assert.equal(production.permissions.actions, "write");
});
