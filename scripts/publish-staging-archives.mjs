// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
/**
 * Publish a staging build's archives to the rolling `staging` GitHub prerelease.
 *
 * Archives carry their version in the name, so uploads never overwrite each
 * other. manifest.json and SHA256SUMS go last, and only when this build is
 * newer than the one the manifest names: staging runs are concurrent per
 * commit, and a late older run must not move the channel backwards. Archives
 * older than the newest KEEP versions are deleted.
 *
 *   GH_TOKEN=… node scripts/publish-staging-archives.mjs <archives-dir>
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import semver from "semver";

const TAG = "staging";
const KEEP = 3;
const dir = process.argv[2];
if (!dir) throw new Error("Usage: node scripts/publish-staging-archives.mjs <archives-dir>");
const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));

function gh(args, { allowFail = false } = {}) {
  const res = spawnSync("gh", args, { encoding: "utf8" });
  if (res.status !== 0 && !allowFail) throw new Error(`gh ${args.join(" ")} failed\n${res.stderr}`);
  return res.status === 0 ? res.stdout : undefined;
}

if (gh(["release", "view", TAG, "--json", "tagName"], { allowFail: true }) === undefined) {
  gh(["release", "create", TAG, "--prerelease", "--latest=false", "--title", "Staging",
    "--notes", "Rolling build of `main`, replaced on every merge. Install with `BIVY_CHANNEL=staging`.",
    "--target", manifest.commit || "main"]);
}

const archives = Object.values(manifest.archives).map((a) => path.join(dir, a.file));
gh(["release", "upload", TAG, ...archives, "--clobber"]);

const current = gh(["release", "download", TAG, "--pattern", "manifest.json", "--output", "-"], { allowFail: true });
const currentVersion = current ? JSON.parse(current).version : undefined;
if (currentVersion && semver.gt(currentVersion, manifest.version)) {
  console.log(`staging already names ${currentVersion}; leaving its manifest in place`);
} else {
  gh(["release", "upload", TAG, path.join(dir, "SHA256SUMS"), path.join(dir, "manifest.json"), "--clobber"]);
  console.log(`staging now names ${manifest.version}`);
}

const assets = JSON.parse(gh(["release", "view", TAG, "--json", "assets"])).assets.map((a) => a.name);
const versionOf = (name) => name.match(/^bivy-(.+)-(?:linux|darwin)-[a-z0-9]+\.tar\.gz$/)?.[1];
const versions = [...new Set(assets.map(versionOf).filter((v) => v && semver.valid(v)))].sort(semver.rcompare);
const keep = new Set(versions.slice(0, KEEP));
for (const name of assets) {
  const version = versionOf(name);
  if (version && !keep.has(version)) gh(["release", "delete-asset", TAG, name, "--yes"], { allowFail: true });
}
