#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
/** Keep every package manifest on the repository's single release version. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function manifestPaths(root = repoRoot) {
  const paths = [path.join(root, "package.json")];
  for (const directory of ["packages", "services"]) {
    const parent = path.join(root, directory);
    if (!fs.existsSync(parent)) continue;
    for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
      const manifest = path.join(parent, entry.name, "package.json");
      if (entry.isDirectory() && fs.existsSync(manifest)) paths.push(manifest);
    }
  }
  return paths.sort((a, b) => a.localeCompare(b));
}

function setReleaseVersion(version, root = repoRoot) {
  if (!STABLE_SEMVER.test(version)) {
    throw new Error(`Invalid release version "${version}"; expected a stable X.Y.Z version.`);
  }

  const changed = [];
  for (const manifest of manifestPaths(root)) {
    const pkg = JSON.parse(fs.readFileSync(manifest, "utf8"));
    if (pkg.version === version) continue;
    pkg.version = version;
    fs.writeFileSync(manifest, `${JSON.stringify(pkg, null, 2)}\n`);
    changed.push(path.relative(root, manifest));
  }
  return changed;
}

function main() {
  // pnpm 11 forwards the conventional argument separator while npm consumes it.
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const version = args[0];
  if (!version || args.length !== 1) {
    console.error("Usage: pnpm run release:version -- X.Y.Z");
    process.exit(2);
  }
  try {
    const changed = setReleaseVersion(version);
    if (changed.length === 0) console.log(`All package manifests are already at ${version}.`);
    else console.log(`Set ${changed.length} package manifests to ${version}:\n${changed.map((file) => `  ${file}`).join("\n")}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();

export { manifestPaths, setReleaseVersion };
