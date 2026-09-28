// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { test } from "node:test";
import { isReleaseOnly } from "../scripts/release-only-diff.mjs";

const manifest = (version: string, extra: Record<string, unknown> = {}) =>
  `${JSON.stringify({ name: "@bivy/core", version, ...extra }, null, 2)}\n`;

test("a version bump plus release notes is release-only", () => {
  assert.equal(
    isReleaseOnly([
      { path: "CHANGELOG.md", before: "## [Unreleased]\n", after: "## [Unreleased]\n\n## [0.2.0]\n- x\n" },
      { path: "package.json", before: manifest("0.1.0"), after: manifest("0.2.0") },
      { path: "packages/core/package.json", before: manifest("0.1.0"), after: manifest("0.2.0") },
    ]),
    true,
  );
});

test("anything beyond versions and notes needs the normal CI tiers", () => {
  const bump = { path: "package.json", before: manifest("0.1.0"), after: manifest("0.2.0") };
  // A manifest change other than the version, e.g. a dependency.
  const dependency = { path: "services/relay/package.json", before: manifest("0.1.0"), after: manifest("0.2.0", { dependencies: { ws: "8" } }) };
  assert.equal(isReleaseOnly([bump, dependency]), false);
  // Any other file, or a created/deleted manifest.
  assert.equal(isReleaseOnly([bump, { path: "src/cli.ts", before: "a", after: "b" }]), false);
  assert.equal(isReleaseOnly([{ path: "packages/new/package.json", before: null, after: manifest("0.2.0") }]), false);
  assert.equal(isReleaseOnly([]), false);
});
