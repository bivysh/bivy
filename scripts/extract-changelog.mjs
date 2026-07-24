#!/usr/bin/env node
// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
/**
 * Extract a single version's section from CHANGELOG.md, for use as the body
 * of the GitHub release created by the tag-triggered release workflow
 * (.github/workflows/release.yml).
 *
 * Usage:
 *   node scripts/extract-changelog.mjs <tag-or-version>
 *
 * <tag-or-version> may be a git tag (`v0.1.0`) or a bare version (`0.1.0`);
 * a leading `v` is stripped. The matching section is everything between the
 * `## [<version>]` heading (Keep a Changelog style, with an optional
 * ` - <date>` suffix) and the next `## [` heading, or end of file.
 *
 * Exits non-zero with a message on stderr if CHANGELOG.md has no section for
 * the requested version -- the release workflow treats that as fatal rather
 * than publishing a GitHub release with an empty/missing body.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function extractChangelogSection(changelog, version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headingRe = new RegExp(`^##\\s*\\[${escaped}\\]`);
  const lines = changelog.split("\n");

  const start = lines.findIndex((line) => headingRe.test(line));
  if (start === -1) return null;

  // Bound the section by the *next* level-2 heading of any shape, not just a
  // bracketed `## [x.y.z]` one -- this CHANGELOG also carries older, undated
  // `## <date>` dev-log headings (predating Keep a Changelog sections), and
  // those must end the previous section rather than being swallowed into it.
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }

  return lines
    .slice(start + 1, end)
    .join("\n")
    .trim();
}

function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error("Usage: node scripts/extract-changelog.mjs <tag-or-version>");
    process.exit(1);
  }
  const version = arg.replace(/^v/, "");

  const changelogPath = path.join(repoRoot, "CHANGELOG.md");
  const changelog = fs.readFileSync(changelogPath, "utf8");

  const section = extractChangelogSection(changelog, version);
  if (section === null) {
    console.error(
      `No "## [${version}]" section found in CHANGELOG.md. Add one before tagging ` +
        `a release -- see docs/releasing.md.`,
    );
    process.exit(1);
  }
  if (section.length === 0) {
    console.error(`The "## [${version}]" section in CHANGELOG.md is empty.`);
    process.exit(1);
  }

  process.stdout.write(`${section}\n`);
}

// Exported for the test suite; only runs as a CLI when invoked directly.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}

export { extractChangelogSection };
