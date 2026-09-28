#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
/**
 * Cut a production release with one command:
 *
 *   pnpm release            # release the version main's package.json names
 *   pnpm release minor      # or major, patch, or an exact X.Y.Z above the last
 *                           # release; retargets main first when it differs
 *   pnpm release --dry-run  # print the version and release notes, change nothing
 *   pnpm release --notes-file notes.md  # add these notes to the release
 *   pnpm release --no-ship  # skip dispatching the Cloud deploy
 *
 * package.json on main holds the version main will release next. A release is
 * a `vX.Y.Z` tag on the current origin/main, which already passed the merge
 * queue and has published staging builds and service images. Pushing the tag
 * starts release.yml (npm `latest`, image aliases, GitHub release), and this
 * script dispatches Cloud's Ship workflow at the same moment so its deploy
 * setup overlaps the publish. A follow-up PR then dates the notes in
 * CHANGELOG.md and moves main to the next patch. See docs/releasing.md.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setReleaseVersion } from "./set-release-version.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const BUMPS = { major: [1, 0, 0], minor: [0, 1, 0], patch: [0, 0, 1] };
const UNRELEASED = /^## \[Unreleased\][^\n]*\n/m;
/** The deployment that follows a release. `--no-ship` skips it. */
const SHIP = { repo: "bivysh/bivy-cloud", workflow: "ship.yml" };

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

function unreleasedSection(changelog) {
  const match = UNRELEASED.exec(changelog);
  if (!match) throw new Error("CHANGELOG.md has no `## [Unreleased]` heading.");
  const bodyStart = match.index + match[0].length;
  const next = changelog.slice(bodyStart).search(/^## /m);
  const end = next === -1 ? changelog.length : bodyStart + next;
  return { bodyStart, end, body: changelog.slice(bodyStart, end).trim() };
}

/** Drop `###` headings left with no entries, and collapse blank runs. */
function tidy(lines) {
  const kept = lines.filter((line, i) => {
    if (!/^#{3,} /.test(line)) return true;
    const rest = lines.slice(i + 1);
    const nextHeading = rest.findIndex((l) => /^#{3,} /.test(l));
    return rest.slice(0, nextHeading === -1 ? undefined : nextHeading).some((l) => l.trim());
  });
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Record a published release: date `notes` under `## [version]` and remove
 * those entries from [Unreleased]. Entries that landed after the release was
 * tagged stay under [Unreleased] for the next one.
 */
function recordRelease(changelog, version, date, notes) {
  const { bodyStart, end, body } = unreleasedSection(changelog);
  const released = new Set(notes.split("\n").filter((line) => line.trim() && !line.startsWith("#")));
  const remaining = tidy(body.split("\n").filter((line) => !released.has(line)));
  const section = `## [${version}] - ${date}\n\n${notes.trim()}\n`;
  const after = changelog.slice(end);
  return `${changelog.slice(0, bodyStart)}\n${remaining ? `${remaining}\n\n` : ""}${section}${after ? `\n${after}` : ""}`;
}

/** Release notes: [Unreleased] at the released commit plus any --notes-file notes. */
function releaseNotes(changelog, extra) {
  return [unreleasedSection(changelog).body, extra.trim()].filter(Boolean).join("\n\n");
}

function sh(command, args, options = {}) {
  return execFileSync(command, args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...options }).trim();
}

/** The highest released `vX.Y.Z` tag, or null. */
function latestRelease() {
  const tags = sh("git", ["tag", "--list", "v*", "--sort=-v:refname"]).split("\n");
  return tags.map((tag) => tag.slice(1)).find((version) => STABLE_SEMVER.test(version)) ?? null;
}

/**
 * Commit `change(worktree)` on top of origin/main in a throwaway worktree, open
 * a PR with auto-merge and return its URL. The caller's checkout is untouched.
 */
function openPullRequest(branch, title, body, change) {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-release-"));
  try {
    sh("git", ["worktree", "add", "--quiet", "-b", branch, worktree, "origin/main"]);
    change(worktree);
    sh("git", ["-C", worktree, "commit", "--quiet", "-am", title]);
    sh("git", ["-C", worktree, "push", "--quiet", "-u", "origin", branch]);
    const url = sh("gh", ["pr", "create", "--base", "main", "--head", branch, "--title", title, "--body", body]);
    sh("gh", ["pr", "merge", url, "--auto", "--squash"]);
    return url;
  } finally {
    sh("git", ["worktree", "remove", "--force", worktree]);
  }
}

/** Wait for a PR to merge and return its merge commit. */
function awaitMerge(url) {
  for (;;) {
    const { state, mergeCommit } = JSON.parse(sh("gh", ["pr", "view", url, "--json", "state,mergeCommit"]));
    if (state === "MERGED") return mergeCommit.oid;
    if (state === "CLOSED") throw new Error(`${url} was closed without merging.`);
    execFileSync("sleep", ["10"]);
  }
}

function parseArgs(argv) {
  const args = argv.filter((arg) => arg !== "--");
  const notesAt = args.indexOf("--notes-file");
  const notesFile = notesAt === -1 ? null : args[notesAt + 1];
  const positional = args.filter((arg, i) => !arg.startsWith("--") && (notesAt === -1 || i !== notesAt + 1));
  if (positional.length > 1 || (notesAt !== -1 && !notesFile)) {
    throw new Error("Usage: pnpm release [minor|major|X.Y.Z] [--notes-file notes.md] [--dry-run] [--no-ship]");
  }
  return {
    bump: positional[0] ?? null,
    dryRun: args.includes("--dry-run"),
    ship: !args.includes("--no-ship"),
    notes: notesFile ? fs.readFileSync(path.resolve(notesFile), "utf8") : "",
  };
}

function main() {
  const { bump, dryRun, ship, notes: extraNotes } = parseArgs(process.argv.slice(2));
  const started = Date.now();
  const elapsed = () => `${Math.round((Date.now() - started) / 1000)}s`;

  sh("git", ["fetch", "--quiet", "--tags", "origin", "main"]);
  let sha = sh("git", ["rev-parse", "origin/main"]);
  const readAt = (commit, file) => sh("git", ["show", `${commit}:${file}`]);
  const target = JSON.parse(readAt(sha, "package.json")).version;
  const released = latestRelease();
  const version = bump ? nextVersion(released ?? target, bump) : target;
  if (sh("git", ["tag", "--list", `v${version}`])) {
    throw new Error(`v${version} is already released. Merge the follow-up version bump PR, then release again.`);
  }
  if (released) nextVersion(released, version); // throws unless newer
  const notes = releaseNotes(readAt(sha, "CHANGELOG.md"), extraNotes);
  if (!notes) throw new Error("There is nothing to release: CHANGELOG.md's [Unreleased] section is empty and no --notes-file was given.");

  if (dryRun) {
    const retarget = version === target ? "" : ` after retargeting main from ${target}`;
    console.log(`Would tag ${sha.slice(0, 12)} (origin/main) as v${version}${retarget}${ship ? ` and dispatch ${SHIP.repo} ${SHIP.workflow}` : ""}.\n\n${notes}`);
    return;
  }

  // Main names a different version (minor/major/exact): land that first. It is
  // a version-only change, so it runs CI's light release tier.
  if (version !== target) {
    const url = openPullRequest(`release/target-v${version}`, `chore(release): target ${version}`, `Retargets main from \`${target}\` to \`${version}\` so \`pnpm release\` can tag it.`, (worktree) => setReleaseVersion(version, worktree));
    console.log(`Retargeting main to ${version}: ${url}\nWaiting for the merge queue...`);
    sha = awaitMerge(url);
    sh("git", ["fetch", "--quiet", "origin", "main"]);
  }

  // The tag is the release. Its message carries --notes-file notes so the
  // workflow can publish them without another commit on main.
  const message = [`Bivy ${version}`, extraNotes.trim()].filter(Boolean);
  sh("git", ["tag", "-a", `v${version}`, sha, ...message.flatMap((m) => ["-m", m])]);
  sh("git", ["push", "--quiet", "origin", `refs/tags/v${version}`]);
  console.log(`[${elapsed()}] Tagged ${sha.slice(0, 12)} as v${version}; release.yml is publishing it.`);

  if (ship) {
    try {
      sh("gh", ["workflow", "run", SHIP.workflow, "--repo", SHIP.repo, "--ref", "main", "-f", `version=v${version}`, "-f", "confirm=production"]);
      console.log(`[${elapsed()}] Dispatched ${SHIP.repo} ${SHIP.workflow}; it deploys once the GitHub release exists.`);
    } catch {
      console.warn(`Could not dispatch ${SHIP.repo} ${SHIP.workflow}; deploy by hand if you run that deployment.`);
    }
  }

  // Off the critical path: date the notes and move main to the next patch.
  const next = nextVersion(version, "patch");
  const date = new Date().toISOString().slice(0, 10);
  const url = openPullRequest(`release/after-v${version}`, `chore(release): record ${version}, target ${next}`, `Records the \`v${version}\` release notes in CHANGELOG.md and moves main to \`${next}\`.`, (worktree) => {
    setReleaseVersion(next, worktree);
    const file = path.join(worktree, "CHANGELOG.md");
    fs.writeFileSync(file, recordRelease(fs.readFileSync(file, "utf8"), version, date, notes));
  });
  console.log(`[${elapsed()}] Follow-up version bump: ${url}\n\n${notes}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

export { nextVersion, recordRelease, releaseNotes };
