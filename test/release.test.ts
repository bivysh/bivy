// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { test } from "node:test";
import { extractChangelogSection } from "../scripts/extract-changelog.mjs";
import { nextVersion, rotateChangelog } from "../scripts/release.mjs";

test("nextVersion bumps by level and resets lower parts", () => {
  assert.equal(nextVersion("0.17.3", "patch"), "0.17.4");
  assert.equal(nextVersion("0.17.3", "minor"), "0.18.0");
  assert.equal(nextVersion("0.17.3", "major"), "1.0.0");
});

test("nextVersion accepts only a newer exact version", () => {
  assert.equal(nextVersion("0.17.3", "0.17.10"), "0.17.10");
  assert.equal(nextVersion("0.17.3", "1.0.0"), "1.0.0");
  assert.throws(() => nextVersion("0.17.3", "0.17.3"), /newer/);
  assert.throws(() => nextVersion("0.17.3", "0.9.9"), /newer/);
  assert.throws(() => nextVersion("0.17.3", "1.0.0-rc.1"), /Unknown bump/);
  assert.throws(() => nextVersion("0.17.3-staging.2", "patch"), /stable/);
});

const CHANGELOG = `# Changelog

## [Unreleased]

### Fixed

- a fix

## [0.17.0] - 2026-09-25

- older
`;

test("rotateChangelog dates the unreleased notes and leaves a fresh [Unreleased]", () => {
  const rotated = rotateChangelog(CHANGELOG, "0.17.1", "2026-09-26");
  assert.match(rotated, /## \[Unreleased\]\n\n## \[0\.17\.1\] - 2026-09-26\n\n### Fixed\n\n- a fix\n\n## \[0\.17\.0\]/);
  assert.equal(extractChangelogSection(rotated, "0.17.1"), "### Fixed\n\n- a fix");
  assert.equal(extractChangelogSection(rotated, "Unreleased"), "");
});

test("rotateChangelog refuses an empty or missing [Unreleased]", () => {
  assert.throws(() => rotateChangelog("## [Unreleased]\n\n## [0.1.0]\n- x\n", "0.1.1", "2026-09-26"), /empty/);
  assert.throws(() => rotateChangelog("# Changelog\n", "0.1.1", "2026-09-26"), /no `## \[Unreleased\]`/);
});
