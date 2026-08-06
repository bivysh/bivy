// Guards the npm release manifest (issue #7): the published package ships only
// bin/, dist/, and public/qr.js, so its package.json must not retain scripts that
// call the dev toolchain or reference source/test/scripts paths that don't ship,
// must carry no devDependencies, and must be publishable (not `private`).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { curateManifest, KEEP_SCRIPTS, DROP_DEPENDENCIES } from "../scripts/release-manifest.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const staged = curateManifest(rootPkg);

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${(error as Error).message}`);
  }
}

// The only paths shipped in the tarball (see scripts/build-release.mjs). Anything a
// staged script references outside these does not exist on an installed package.
const SHIPPED_DIRS = ["bin", "dist", "public"];
// Markers of things that DON'T ship: dev binaries and non-shipped source trees.
const FORBIDDEN = [
  /\btsx\b/,
  /\btsc\b/,
  /\beslint\b/,
  /\bplaywright\b/,
  /(?:^|[\s"'`=./])(?:src|test|scripts|services|packages|deploy|docs)\//,
];

check("no staged script references a path or tool that isn't in the tarball", () => {
  for (const [name, cmd] of Object.entries(staged.scripts ?? {})) {
    for (const re of FORBIDDEN) {
      assert.ok(!re.test(cmd as string), `script "${name}" references non-shipped path/tool: ${cmd}`);
    }
    // Every relative dir a script references must be one that ships.
    for (const m of (cmd as string).matchAll(/(?:^|[\s"'`])([a-z0-9_-]+)\//gi)) {
      assert.ok(
        SHIPPED_DIRS.includes(m[1]),
        `script "${name}" references directory "${m[1]}/" which is not shipped: ${cmd}`,
      );
    }
  }
});

check("only allowlisted scripts survive", () => {
  const surviving = Object.keys(staged.scripts ?? {}).sort();
  const allowed = [...KEEP_SCRIPTS].sort();
  assert.deepEqual(surviving, allowed, `staged scripts ${JSON.stringify(surviving)} != allowlist ${JSON.stringify(allowed)}`);
});

check("known dev-only scripts are dropped", () => {
  for (const dead of ["agent-service", "typecheck", "lint", "test:unit", "test:browser", "build:release", "publish:npm", "prepare", "prepublishOnly", "agent", "pi"]) {
    assert.ok(!(dead in (staged.scripts ?? {})), `dead script "${dead}" survived into the release manifest`);
  }
});

check("runtime entry points point at compiled dist, not tsx/src", () => {
  assert.equal(staged.scripts?.start, "node dist/server.js");
  assert.equal(staged.scripts?.dev, "node dist/server.js");
});

check("devDependencies are dropped entirely", () => {
  assert.ok(!("devDependencies" in staged), "staged manifest must ship no devDependencies");
});

check("mobile-only dependencies are pruned", () => {
  for (const dep of DROP_DEPENDENCIES) {
    assert.ok(!(dep in (staged.dependencies ?? {})), `mobile dep "${dep}" must not ship`);
  }
});

check("runtime dependencies are retained", () => {
  // A representative shipped runtime dep must survive the prune.
  assert.ok(staged.dependencies?.express, "express (a runtime dep) must be retained");
});

check("workspaces field is dropped", () => {
  assert.ok(!("workspaces" in staged), "staged manifest must not carry the monorepo workspaces field");
});

check("staged manifest is publishable and declares the thin pi bundle", () => {
  assert.ok(!("private" in staged), "staged manifest must not be private (the repo root is; the staging dir publishes)");
  assert.deepEqual(staged.bundledDependencies, ["@earendil-works/pi-coding-agent"]);
});

check("release README is explicit in npm registry metadata", () => {
  const withReadme = curateManifest(rootPkg, "# Bivy\n\nRelease documentation.\n");
  assert.equal(withReadme.readmeFilename, "README.md");
  assert.equal(withReadme.readme, "# Bivy\n\nRelease documentation.\n");
});

check("curateManifest does not mutate its input", () => {
  assert.ok(rootPkg.devDependencies, "input package.json should still have devDependencies after curation");
  assert.equal(rootPkg.private, true, "input package.json should still be private after curation");
});

if (failures) {
  console.error(`\nrelease-manifest: ${failures} test(s) failed`);
  process.exit(1);
}
console.log("\nrelease-manifest: all tests passed");
