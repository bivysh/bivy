#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
/**
 * Is a commit range nothing but a release: version fields and release notes?
 *
 *   node scripts/release-only-diff.mjs <base> <head>   # prints true or false
 *
 * `pnpm release` produces exactly this shape: every package manifest's
 * `version` and CHANGELOG.md. The code it ships already passed CI on main, so
 * CI runs a light tier for such a range (ci.yml) and release.yml accepts that
 * run as the release receipt. Anything else in the range fails closed.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Files a release may touch, and how much of each it may change. */
const RELEASE_FILES = [
  { match: /^CHANGELOG\.md$/, versionOnly: false },
  { match: /^(packages\/[^/]+\/|services\/[^/]+\/)?package\.json$/, versionOnly: true },
];

function withoutVersion(text) {
  if (text === null) return null;
  const { version: _version, ...rest } = JSON.parse(text);
  return JSON.stringify(rest);
}

/** `changes` is `[{ path, before, after }]`, with null for an absent side. */
function isReleaseOnly(changes) {
  if (changes.length === 0) return false;
  return changes.every(({ path: file, before, after }) => {
    const rule = RELEASE_FILES.find(({ match }) => match.test(file));
    if (!rule || before === null || after === null) return false;
    return !rule.versionOnly || withoutVersion(before) === withoutVersion(after);
  });
}

function git(args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function readAt(ref, file) {
  try {
    return git(["show", `${ref}:${file}`]);
  } catch {
    return null;
  }
}

function releaseOnlyRange(base, head) {
  const files = git(["diff", "--name-only", "--no-renames", base, head]).split("\n").filter(Boolean);
  return isReleaseOnly(files.map((file) => ({ path: file, before: readAt(base, file), after: readAt(head, file) })));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [base, head] = process.argv.slice(2);
  if (!base || !head) {
    console.error("Usage: node scripts/release-only-diff.mjs <base> <head>");
    process.exit(2);
  }
  let result = false;
  try {
    result = releaseOnlyRange(base, head);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
  }
  console.log(result);
}

export { isReleaseOnly };
