// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
/**
 * Release cooldown for dependencies the repo never resolved.
 *
 * pnpm owns the repo and refuses versions younger than `minimumReleaseAge`, so
 * everything in pnpm-lock.yaml has sat on the registry for a while and passed
 * review and CI. A release, though, is resolved again by npm from the curated
 * manifest (see build-release.mjs), and npm takes the newest version in range
 * with no cooldown. A dependency hijacked an hour before a release would ship to
 * every install. This gate closes that: each package@version in the release lock
 * must either be one pnpm-lock.yaml already holds, or be at least as old as
 * pnpm's cooldown.
 *
 *   node scripts/release-lock-age.mjs <package-lock.json>
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** pnpm's own default; pnpm-workspace.yaml may set it explicitly. */
const DEFAULT_MIN_AGE_MINUTES = 1440;

/** `minimumReleaseAge` from pnpm-workspace.yaml, in minutes. */
export function minimumReleaseAge(workspaceYaml = fs.readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8")) {
  const match = workspaceYaml.match(/^minimumReleaseAge:\s*(\d+)\s*$/m);
  return match ? Number(match[1]) : DEFAULT_MIN_AGE_MINUTES;
}

/** Every `name@version` pnpm-lock.yaml resolves, peer suffixes stripped. */
export function pnpmLockedVersions(lockYaml = fs.readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8")) {
  const out = new Set();
  for (const match of lockYaml.matchAll(/^ {2}'?((?:@[^@/\s']+\/)?[^@\s'(]+)@([^(\s':]+)/gm)) {
    out.add(`${match[1]}@${match[2]}`);
  }
  return out;
}

/** Every registry package@version in an npm v2/v3 package-lock. */
export function npmLockedPackages(lock) {
  const out = new Map();
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (!key || entry.link || !entry.version || !entry.resolved?.startsWith("https://registry.npmjs.org/")) continue;
    const name = entry.name ?? key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
    out.set(`${name}@${entry.version}`, { name, version: entry.version });
  }
  return [...out.values()];
}

async function publishedAt({ name, version }) {
  const response = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2F")}`);
  if (!response.ok) throw new Error(`registry ${response.status} for ${name}`);
  const time = (await response.json()).time?.[version];
  if (!time) throw new Error(`registry lists no publish time for ${name}@${version}`);
  return new Date(time);
}

/**
 * Packages in `lock` that pnpm-lock.yaml does not hold and that are younger than
 * the cooldown. `lookup` is injectable so the rule can be tested offline.
 */
export async function tooYoung(lock, { locked = pnpmLockedVersions(), minAgeMinutes = minimumReleaseAge(), now = Date.now(), lookup = publishedAt } = {}) {
  const unreviewed = npmLockedPackages(lock).filter((pkg) => !locked.has(`${pkg.name}@${pkg.version}`));
  const young = [];
  for (let i = 0; i < unreviewed.length; i += 8) {
    const batch = unreviewed.slice(i, i + 8);
    const times = await Promise.all(batch.map(lookup));
    batch.forEach((pkg, j) => {
      const ageMinutes = (now - times[j].getTime()) / 60000;
      if (ageMinutes < minAgeMinutes) young.push({ ...pkg, ageMinutes: Math.floor(ageMinutes) });
    });
  }
  return young;
}

/** Throws, naming each package, when the release lock pulls in a too-new version. */
export async function assertReleaseLockAged(lockFile) {
  const minAgeMinutes = minimumReleaseAge();
  const young = await tooYoung(JSON.parse(fs.readFileSync(lockFile, "utf8")), { minAgeMinutes });
  if (!young.length) return;
  const list = young.map((pkg) => `  ${pkg.name}@${pkg.version} (published ${pkg.ageMinutes} min ago)`).join("\n");
  throw new Error(
    `The release lock resolves versions pnpm-lock.yaml does not hold and that are younger than the ${minAgeMinutes}-minute cooldown:\n${list}\n` +
    "Wait for the cooldown, or update pnpm-lock.yaml so the version goes through review and CI first.",
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const lockFile = process.argv[2];
  if (!lockFile) {
    console.error("usage: node scripts/release-lock-age.mjs <package-lock.json>");
    process.exit(2);
  }
  assertReleaseLockAged(lockFile).then(
    () => console.log(`${lockFile}: every dependency is reviewed or past the cooldown`),
    (error) => {
      console.error(error.message);
      process.exit(1);
    },
  );
}
