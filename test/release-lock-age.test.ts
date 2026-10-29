// A release re-resolves its dependencies with npm, which has no cooldown. The
// gate in scripts/release-lock-age.mjs lets through what pnpm-lock.yaml already
// holds and anything past the cooldown, and stops a version published minutes
// before the release.
import assert from "node:assert/strict";
import { pnpmLockedVersions, reviewedDirectPins, reviewedReplacements, tooYoung } from "../scripts/release-lock-age.mjs";

const now = Date.parse("2026-10-28T12:00:00Z");
const published: Record<string, string> = {
  "fresh@2.0.1": "2026-10-28T11:00:00Z",
  "old@1.0.1": "2026-10-01T00:00:00Z",
};
const lock = {
  packages: {
    "": { name: "app", version: "1.0.0" },
    "node_modules/reviewed": { version: "3.0.0", resolved: "https://registry.npmjs.org/reviewed/-/reviewed-3.0.0.tgz" },
    "node_modules/@scope/old": { version: "1.0.1", resolved: "https://registry.npmjs.org/@scope/old/-/old-1.0.1.tgz" },
    "node_modules/reviewed/node_modules/fresh": { version: "2.0.1", resolved: "https://registry.npmjs.org/fresh/-/fresh-2.0.1.tgz" },
    "node_modules/workspace": { link: true, resolved: "packages/workspace" },
  },
};

const locked = pnpmLockedVersions([
  "packages:",
  "",
  "  reviewed@3.0.0:",
  "    resolution: {integrity: sha512-x}",
  "",
  "snapshots:",
  "",
  "  '@scope/peer@1.2.3(zod@4.0.0)':",
].join("\n"));
assert.deepEqual([...locked].sort(), ["@scope/peer@1.2.3", "reviewed@3.0.0"]);

const lookups: string[] = [];
const young = await tooYoung(lock, {
  locked,
  minAgeMinutes: 1440,
  now,
  lookup: async ({ name, version }: { name: string; version: string }) => {
    lookups.push(`${name}@${version}`);
    return new Date(published[`${name.replace("@scope/", "")}@${version}`]);
  },
});

assert.deepEqual(lookups.sort(), ["@scope/old@1.0.1", "fresh@2.0.1"], "only unreviewed versions hit the registry");
assert.deepEqual(young, [{ name: "fresh", version: "2.0.1", ageMinutes: 60 }]);
console.log("  ok  release lock age gate");

// A too-young transitive version is held back to the newest reviewed version on
// its release line; other lines, prereleases and direct dependencies are not.
assert.deepEqual(
  reviewedReplacements(
    [
      { name: "fresh", version: "2.0.1" },
      { name: "@scope/zero", version: "0.4.2" },
      { name: "unreviewed", version: "1.0.1" },
      { name: "direct", version: "1.2.1" },
    ],
    new Set(["fresh@1.9.9", "fresh@2.0.0", "fresh@2.0.0-rc.1", "fresh@3.0.0", "@scope/zero@0.3.9", "@scope/zero@0.4.0", "direct@1.2.0"]),
    { direct: "^1.2.0" },
  ),
  { "fresh@2.0.1": "2.0.0", "@scope/zero@0.4.2": "0.4.0" },
);
console.log("  ok  too-young versions fall back to reviewed ones");

// A too-young direct dependency is pinned to the newest reviewed version, but
// only when that version still satisfies the declared range.
assert.deepEqual(
  reviewedDirectPins(
    [{ name: "direct", version: "1.2.2" }, { name: "narrow", version: "1.3.1" }, { name: "fresh", version: "2.0.1" }],
    new Set(["direct@1.2.0", "direct@1.2.1", "narrow@1.3.0", "fresh@2.0.0"]),
    { direct: "^1.2.1", narrow: "^1.3.1" },
  ),
  { direct: "1.2.1" },
);
console.log("  ok  too-young direct dependencies pin to a reviewed version in range");
