#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
/**
 * Cut a production release with one command:
 *
 *   pnpm release            # patch (default)
 *   pnpm release minor      # or major, or an exact X.Y.Z
 *   pnpm release --dry-run  # print the version and release notes, change nothing
 *
 * Branches from the latest origin/main, sets every manifest to the new version,
 * dates CHANGELOG.md's [Unreleased] section, opens the release PR and enables
 * auto-merge. When that commit lands on main, release.yml notices the unreleased
 * package.json version and promotes it to npm `latest` on its own (still behind
 * the `release` environment approval). See docs/releasing.md.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractChangelogSection } from "./extract-changelog.mjs";
import { setReleaseVersion } from "./set-release-version.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const BUMPS = { major: [1, 0, 0], minor: [0, 1, 0], patch: [0, 0, 1] };
const UNRELEASED = /^## \[Unreleased\][^\n]*\n/m;

/** `current` bumped by `major|minor|patch`, or an explicit stable version above it. */
function nextVersion(current, bump) {
  const parts = current.match(STABLE_SEMVER)?.slice(1).map(Number);
  if (!parts) throw new Error(`Current version "${current}" is not a stable X.Y.Z.`);
  if (STABLE_SEMVER.test(bump)) {
    const target = bump.split(".").map(Number);
    const newer = target.findIndex((n, i) => n !== parts[i]);
    if (newer === -1 || target[newer] < parts[newer]) {
      throw new Error(`Release version ${bump} must be newer than ${current}.`);
    }
    return bump;
  }
  const step = BUMPS[bump];
  if (!step) throw new Error(`Unknown bump "${bump}"; use major, minor, patch, or an exact X.Y.Z.`);
  const level = step.indexOf(1);
  return parts.map((n, i) => (i < level ? n : i === level ? n + 1 : 0)).join(".");
}

/** Move [Unreleased] under a dated `## [version]` heading, leaving a fresh [Unreleased]. */
function rotateChangelog(changelog, version, date) {
  const match = UNRELEASED.exec(changelog);
  if (!match) throw new Error("CHANGELOG.md has no `## [Unreleased]` heading.");
  const bodyStart = match.index + match[0].length;
  const next = changelog.slice(bodyStart).search(/^## /m);
  const body = changelog.slice(bodyStart, next === -1 ? undefined : bodyStart + next).trim();
  if (!body) throw new Error("CHANGELOG.md's [Unreleased] section is empty; there is nothing to release.");
  return `${changelog.slice(0, bodyStart)}\n## [${version}] - ${date}\n${changelog.slice(bodyStart)}`;
}

function sh(command, args, options = {}) {
  return execFileSync(command, args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...options }).trim();
}

function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const dryRun = args.includes("--dry-run");
  const positional = args.filter((arg) => !arg.startsWith("--"));
  if (positional.length > 1) {
    console.error("Usage: pnpm release [patch|minor|major|X.Y.Z] [--dry-run]");
    process.exit(2);
  }

  sh("git", ["fetch", "--quiet", "origin", "main"]);
  const readMain = (file) => sh("git", ["show", `origin/main:${file}`]);
  const current = JSON.parse(readMain("package.json")).version;
  const version = nextVersion(current, positional[0] ?? "patch");
  const date = new Date().toISOString().slice(0, 10);
  const changelog = rotateChangelog(readMain("CHANGELOG.md"), version, date);

  if (dryRun) {
    console.log(`Would release ${current} -> ${version}\n\n${extractChangelogSection(changelog, version)}`);
    return;
  }

  if (sh("git", ["status", "--porcelain"])) throw new Error("Working tree is not clean; commit or set aside your changes first.");
  const branch = `release/v${version}`;
  const returnTo = sh("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  sh("git", ["switch", "--quiet", "-c", branch, "origin/main"]);
  try {
    setReleaseVersion(version);
    fs.writeFileSync(path.join(repoRoot, "CHANGELOG.md"), changelog);
    sh("git", ["commit", "--quiet", "-am", `chore(release): ${version}`]);
    sh("git", ["push", "--quiet", "-u", "origin", branch]);
    const body = [
      `Releases \`${version}\` (previously \`${current}\`).`,
      "",
      "Merging this lands the version bump on `main`; the Release workflow then publishes the staging",
      "candidate and promotes it to npm `latest` automatically once the `release` environment is approved.",
    ].join("\n");
    const url = sh("gh", ["pr", "create", "--base", "main", "--head", branch, "--title", `chore(release): ${version}`, "--body", body]);
    sh("gh", ["pr", "merge", url, "--auto", "--squash"]);
    console.log(`Release PR for ${version}: ${url}\nAuto-merge is on; approve the \`release\` environment when the Release run asks.`);
  } finally {
    if (returnTo !== "HEAD") sh("git", ["switch", "--quiet", returnTo]);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

export { nextVersion, rotateChangelog };
