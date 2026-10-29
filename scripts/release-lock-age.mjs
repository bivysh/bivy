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
 * resolveReleaseLock() resolves with that rule rather than only failing on it: a
 * transitive version too new for the cooldown is pinned back to the version
 * pnpm-lock.yaml reviewed on the same release line, so a patch published an
 * hour ago doesn't block every build until it ages.
 *
 *   node scripts/release-lock-age.mjs <package-lock.json>
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
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
  const response = await fetch(`https://registry.npmjs.org/${name.replaceAll("/", "%2F")}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
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
  if (unreviewed.length) console.log(`Checking publish dates of ${unreviewed.length} release dependencies not in pnpm-lock.yaml…`);
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

/** `x.y.z` as numbers, or null for anything else (prereleases never stand in). */
function plainVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return match ? match.slice(1).map(Number) : null;
}

/** Compare two `plainVersion`s: negative when `a` is older. */
function compareVersions(a, b) {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * The newest version of `name` older than `version` that pnpm-lock.yaml holds on
 * the same release line (same major, or same minor for 0.x), so every range that
 * accepted the young version accepts it too. Null when there is none.
 */
function reviewedOlder(name, version, locked) {
  const target = plainVersion(version);
  if (!target) return null;
  const line = target[0] === 0 ? 2 : 1;
  let best = null;
  for (const entry of locked) {
    const at = entry.lastIndexOf("@");
    if (at <= 0 || entry.slice(0, at) !== name) continue;
    const candidate = plainVersion(entry.slice(at + 1));
    if (!candidate || candidate.slice(0, line).join(".") !== target.slice(0, line).join(".")) continue;
    if (compareVersions(candidate, target) >= 0) continue;
    if (!best || compareVersions(candidate, best) > 0) best = candidate;
  }
  return best;
}

/**
 * npm overrides that replace each too-young transitive version with the newest
 * reviewed one (see reviewedOlder). Keys are scoped to the young version
 * (`name@version`), leaving other copies alone. npm refuses to override a direct
 * dependency, so those are pinned by reviewedDirectPins instead.
 */
export function reviewedReplacements(young, locked, directDependencies = {}) {
  const overrides = {};
  for (const { name, version } of young) {
    if (name in directDependencies) continue;
    const best = reviewedOlder(name, version, locked);
    if (best) overrides[`${name}@${version}`] = best.join(".");
  }
  return overrides;
}

/** Whether `version` satisfies a plain `^x.y.z`, `~x.y.z` or `x.y.z` spec. */
function satisfiesSimpleRange(version, spec) {
  const match = /^([\^~]?)(\d+\.\d+\.\d+)$/.exec(String(spec).trim());
  const base = match && plainVersion(match[2]);
  if (!base || compareVersions(version, base) < 0) return false;
  if (match[1] === "") return compareVersions(version, base) === 0;
  const line = match[1] === "~" || base[0] === 0 ? 2 : 1;
  return version.slice(0, line).join(".") === base.slice(0, line).join(".");
}

/**
 * Exact specs for too-young direct dependencies: the newest reviewed version
 * (see reviewedOlder), when it still satisfies the declared range.
 */
export function reviewedDirectPins(young, locked, directDependencies = {}) {
  const pins = {};
  for (const { name, version } of young) {
    if (!(name in directDependencies)) continue;
    const best = reviewedOlder(name, version, locked);
    if (best && satisfiesSimpleRange(best, directDependencies[name])) pins[name] = best.join(".");
  }
  return pins;
}

function lockOnly(dir) {
  const res = spawnSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: dir, stdio: "inherit" });
  if (res.status !== 0) throw new Error(`npm install --package-lock-only failed in ${dir} (${res.status ?? res.signal})`);
}

/**
 * Writes `<dir>/package-lock.json` for `<dir>/package.json`, holding back
 * too-new transitive versions to the ones pnpm-lock.yaml reviewed (recorded as
 * overrides in package.json, so `npm ci` and later installs agree), then gates
 * the result.
 */
export async function resolveReleaseLock(dir) {
  const lockFile = path.join(dir, "package-lock.json");
  const pkgFile = path.join(dir, "package.json");
  lockOnly(dir);
  const young = await tooYoung(JSON.parse(fs.readFileSync(lockFile, "utf8")));
  if (young.length) {
    const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
    const locked = pnpmLockedVersions();
    const pins = reviewedReplacements(young, locked, pkg.dependencies);
    const direct = reviewedDirectPins(young, locked, pkg.dependencies);
    if (Object.keys(pins).length || Object.keys(direct).length) {
      console.log(`Holding back to reviewed versions: ${[...Object.entries(pins), ...Object.entries(direct)].map(([from, to]) => `${from} → ${to}`).join(", ")}`);
      pkg.overrides = { ...pkg.overrides, ...pins };
      pkg.dependencies = { ...pkg.dependencies, ...direct };
      fs.writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`);
      // From scratch: npm keeps a locked version even when an override now excludes it.
      fs.rmSync(lockFile);
      lockOnly(dir);
    }
  }
  await assertReleaseLockAged(lockFile);
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
