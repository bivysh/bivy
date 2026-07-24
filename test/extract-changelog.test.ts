import assert from "node:assert";
import { extractChangelogSection } from "../scripts/extract-changelog.mjs";

const SAMPLE = `# Changelog

## [Unreleased]

### Added
- something new

## [0.1.0] - 2026-07-21

First public release.

### Highlights

- one
- two

## 2026-06-29
- pre-changelog notes
`;

function run() {
  // Extracts the body between a version heading and the next \`## [\` heading.
  const v010 = extractChangelogSection(SAMPLE, "0.1.0");
  assert.ok(v010.startsWith("First public release."), "starts right after the heading");
  assert.ok(v010.includes("- one"), "includes body content");
  assert.ok(!v010.includes("2026-06-29"), "stops before the next section");
  assert.ok(!v010.includes("[0.1.0]"), "excludes its own heading line");

  // A dated heading suffix (` - 2026-07-21`) doesn't need to be part of the match.
  const unreleased = extractChangelogSection(SAMPLE, "Unreleased");
  assert.ok(unreleased.includes("- something new"), "matches an undated heading like [Unreleased]");
  assert.ok(!unreleased.includes("First public release"), "stops before the next version section");

  // A `v`-prefixed tag is not accepted directly -- callers strip the `v` first
  // (see extract-changelog.mjs's CLI entrypoint), so the raw version must match.
  assert.equal(extractChangelogSection(SAMPLE, "v0.1.0"), null, "does not match a v-prefixed version");

  // Missing version.
  assert.equal(extractChangelogSection(SAMPLE, "9.9.9"), null, "missing version returns null");

  // Version string is regex-escaped, not interpreted as a pattern.
  assert.equal(extractChangelogSection(SAMPLE, "0x1x0"), null, "version is matched literally, not as regex");

  // Last section in the file runs to EOF.
  const legacyLike = extractChangelogSection("## [1.0.0]\nbody only, no trailing section\n", "1.0.0");
  assert.equal(legacyLike, "body only, no trailing section", "runs to end of file when there's no next heading");

  console.log("extract-changelog: all tests passed");
}

run();
