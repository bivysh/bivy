// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { test } from "node:test";
import { extractChangelogSection } from "../scripts/extract-changelog.mjs";
import { nextVersion, recordRelease, releaseNotes } from "../scripts/release.mjs";

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

test("releaseNotes joins [Unreleased] with --notes-file notes and is empty when both are", () => {
  assert.equal(releaseNotes(CHANGELOG, "### Added\n\n- a feature\n"), "### Fixed\n\n- a fix\n\n### Added\n\n- a feature");
  assert.equal(releaseNotes("## [Unreleased]\n\n## [0.1.0]\n- x\n", ""), "");
  assert.throws(() => releaseNotes("# Changelog\n", ""), /no `## \[Unreleased\]`/);
});

test("recordRelease dates the released notes and leaves a fresh [Unreleased]", () => {
  const notes = releaseNotes(CHANGELOG, "- from the tag");
  const recorded = recordRelease(CHANGELOG, "0.17.1", "2026-09-26", notes);
  assert.match(recorded, /## \[Unreleased\]\n\n## \[0\.17\.1\] - 2026-09-26\n\n### Fixed\n\n- a fix\n\n- from the tag\n\n## \[0\.17\.0\]/);
  assert.equal(extractChangelogSection(recorded, "Unreleased"), "");
  assert.equal(extractChangelogSection(recorded, "0.17.0"), "- older");
});

test("recordRelease keeps entries that landed after the release was tagged", () => {
  const later = CHANGELOG.replace("- a fix\n", "- a fix\n- a later fix\n\n### Added\n\n- a later feature\n");
  const recorded = recordRelease(later, "0.17.1", "2026-09-26", releaseNotes(CHANGELOG, ""));
  assert.equal(extractChangelogSection(recorded, "Unreleased"), "### Fixed\n\n- a later fix\n\n### Added\n\n- a later feature");
  assert.equal(extractChangelogSection(recorded, "0.17.1"), "### Fixed\n\n- a fix");
});
