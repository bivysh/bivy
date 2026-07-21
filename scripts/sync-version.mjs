#!/usr/bin/env node
// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
// The release version lives in six places with nothing tying them together, so
// a version bump silently misses one:
//   - package.json (root — the source of truth)
//   - packages/core/package.json
//   - packages/web/package.json
//   - services/control-plane/package.json
//   - services/relay/package.json
//   - bin/codex-app-server-shim.mjs — a hardcoded string literal inside
//     `clientInfo`, invisible to any lockfile/JSON-based check
//
// This copies the root package.json's version into the other five, with a
// scoped string replace (not JSON.parse/stringify) so formatting is left
// untouched. Run with `--check` (used in CI) to fail on drift without writing.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const JSON_VERSION_PATTERN = /"version"\s*:\s*"([^"]*)"/;
const SHIM_VERSION_PATTERN = /(clientInfo:\s*\{[^}]*?\bversion:\s*)"([^"]*)"/;

function jsonTarget(rel) {
  return {
    rel,
    read: (text) => text.match(JSON_VERSION_PATTERN)?.[1] ?? null,
    write: (text, version) => text.replace(JSON_VERSION_PATTERN, `"version": "${version}"`),
  };
}

const shimTarget = {
  rel: "bin/codex-app-server-shim.mjs",
  read: (text) => text.match(SHIM_VERSION_PATTERN)?.[2] ?? null,
  write: (text, version) => text.replace(SHIM_VERSION_PATTERN, (_match, prefix) => `${prefix}"${version}"`),
};

export const TARGETS = [
  jsonTarget("packages/core/package.json"),
  jsonTarget("packages/web/package.json"),
  jsonTarget("services/control-plane/package.json"),
  jsonTarget("services/relay/package.json"),
  shimTarget,
];

// Reads the root package.json's version and syncs (or, with `check: true`,
// diffs without writing) it into every entry in `targets`. Pure I/O rooted at
// `repoRoot` and no process.exit, so tests can point it at a scratch
// directory instead of the real repo.
export function syncVersion(repoRoot, { check = false, targets = TARGETS } = {}) {
  const rootPackageJsonPath = path.join(repoRoot, "package.json");
  const version = JSON.parse(fs.readFileSync(rootPackageJsonPath, "utf8")).version;
  if (typeof version !== "string" || !version) {
    throw new Error(`Could not read a "version" string from ${rootPackageJsonPath}`);
  }

  const updated = [];
  const drifted = [];
  const problems = [];

  for (const target of targets) {
    const abs = path.join(repoRoot, target.rel);
    if (!fs.existsSync(abs)) {
      problems.push(`${target.rel}: file not found`);
      continue;
    }
    const text = fs.readFileSync(abs, "utf8");
    const current = target.read(text);
    if (current == null) {
      problems.push(`${target.rel}: could not find a version string to sync`);
      continue;
    }
    if (current === version) continue;

    if (check) {
      drifted.push({ rel: target.rel, current });
      continue;
    }

    fs.writeFileSync(abs, target.write(text, version));
    updated.push({ rel: target.rel, from: current, to: version });
  }

  return { version, updated, drifted, problems };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const check = process.argv.slice(2).includes("--check");
  const result = syncVersion(repoRoot, { check });

  if (result.problems.length) {
    console.error("version sync failed:\n" + result.problems.map((p) => `  - ${p}`).join("\n"));
    process.exit(1);
  }

  if (check) {
    if (result.drifted.length) {
      console.error(
        `version drift detected (root package.json is at ${result.version}):\n` +
          result.drifted.map((d) => `  - ${d.rel} has "${d.current}"`).join("\n"),
      );
      process.exit(1);
    }
    console.log(`version check passed: all ${TARGETS.length} locations match ${result.version}.`);
    process.exit(0);
  }

  for (const u of result.updated) console.log(`updated ${u.rel}: ${u.from} -> ${u.to}`);
  console.log(`version sync complete: all ${TARGETS.length} locations match ${result.version}.`);
}
