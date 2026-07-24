#!/usr/bin/env node
// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
/**
 * Build the `bivy` release artifact.
 *
 * Compiles src/ to dist/, then stages a curated package directory containing
 * only what a packaged install needs: dist/, bin/, public/qr.js, package
 * metadata, README and LICENSE. It intentionally excludes src/, deploy/, the
 * hosted services, tests, and internal docs.
 *
 * npm is the primary distribution channel (content-addressed tarballs, integrity
 * verified on install, --provenance attestation from CI). BUT install.sh still
 * falls back to a self-hosted tarball + manifest at bivy.sh/downloads whenever
 * the npm registry 404s (e.g. before an npm release exists), so `--pack` also
 * emits that tarball. Keeping the download channel current is what lets the
 * every-merge staging build reach existing packaged nodes via `bivy update`.
 *
 *   npm run build:release          stage the package, don't publish
 *   npm run publish:npm            stage and publish to npm
 *   npm run publish:npm:dry        stage and dry-run publish
 *   node scripts/build-release.mjs --pack <dir>
 *                                  stage and write <dir>/bivy-latest.tar.gz +
 *                                  bivy-latest.json (self-hosted download channel)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const argv = process.argv.slice(2);
const doPublish = argv.includes("--publish");
const dryRunPublish = argv.includes("--dry-run");
/** Read the value that follows a `--flag` on the command line (or undefined). */
function argValue(flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}
// Where to emit the self-hosted tarball + manifest. Empty = don't (npm-only run).
const packDir = argValue("--pack");

const root = path.resolve(new URL("..", import.meta.url).pathname);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-release-"));
const app = path.join(tmp, "bivy");

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { cwd: root, stdio: "inherit", ...opts });
  if (res.status !== 0) process.exit(res.status ?? 1);
}

function copy(src, dest) {
  fs.cpSync(path.join(root, src), path.join(app, dest ?? src), {
    recursive: true,
    filter: (p) => {
      const base = path.basename(p);
      return base !== ".DS_Store" && !p.includes(`${path.sep}node_modules${path.sep}`) && !p.endsWith(`${path.sep}node_modules`);
    },
  });
}

fs.rmSync(path.join(root, "dist"), { recursive: true, force: true });
run("npx", ["tsc", "--noEmit", "false", "--rootDir", "src"]);
fs.mkdirSync(path.join(root, "dist"), { recursive: true });
// tsc does not emit .mjs helper modules. Keep runtime imports in dist complete.
for (const file of ["hosted-endpoints.mjs", "hosted-endpoints.d.mts", "pty-runner.py"]) {
  fs.copyFileSync(path.join(root, "src", file), path.join(root, "dist", file));
}

// The node is a pure data plane and no longer hosts the web UI, so the release
// artifact ships no PWA bundle. The React/Vite app (@bivy/web) is built and
// served independently by the control plane (see deploy/Dockerfile.control-plane
// + services/control-plane). The CLI still needs public/qr.js at runtime for
// `bivy link`/setup QR rendering, so that single file ships; the PWA-only images
// under public/ are dropped.
fs.mkdirSync(app, { recursive: true });
for (const item of [
  ["bin", "bin"],
  ["dist", "dist"],
  ["public/qr.js", "public/qr.js"],
  ["package.json", "package.json"],
  ["README.md", "README.md"],
  ["LICENSE", "LICENSE"],
]) {
  copy(item[0], item[1]);
}

// The private monorepo currently contains mobile dependencies that are not
// needed by the node installer. Keep the downloadable package small and focused.
const pkgPath = path.join(app, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
for (const dep of ["expo", "react", "react-native"]) delete pkg.dependencies?.[dep];
for (const dep of ["heroicons"]) delete pkg.devDependencies?.[dep];
pkg.scripts.start = "node dist/server.js";
pkg.scripts.dev = "node dist/server.js";
// `prepare` runs a dev-only git-hook cleanup (scripts/disable-git-hooks.mjs),
// which is neither shipped in the release nor meaningful in a packaged, non-git
// install. npm runs `prepare` automatically on `npm install`, so leaving it in
// aborts the installer with MODULE_NOT_FOUND. Drop it from the artifact.
delete pkg.scripts.prepare;
// The staging dir IS the sanctioned publish path, so drop the root's
// `prepublishOnly` guard here — it exists only to hard-fail a stray
// `npm publish` from the repo root (which would ship the whole monorepo).
delete pkg.scripts.prepublishOnly;
// The artifact ships no `packages/` workspaces (the web PWA is built/served by
// the control plane, not the node). Drop the monorepo `workspaces` field and the
// workspace-scoped scripts so they don't dangle in the installed package.
delete pkg.workspaces;
for (const s of ["build:web", "dev:web", "test:core", "typecheck:web"]) delete pkg.scripts?.[s];
fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
run("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: app });

const releasePkg = JSON.parse(fs.readFileSync(path.join(app, "package.json"), "utf8"));

// Publish the curated staging dir to npm. The staged package.json has already
// been corrected for a packaged install (start/dev -> node dist/server.js, the
// dev-only `prepare` git-hook script removed, mobile deps pruned), and the
// staging dir has no node_modules. Run from `app`, not the repo root, to avoid
// the `prepare` MODULE_NOT_FOUND trap and shipping src/, services/, docs/, etc.
//
// Provenance: when running in GitHub Actions with id-token permission, publish
// with --provenance so npm records a signed attestation of the workflow, repo,
// and commit that produced the package. That is what replaces the old
// self-managed Ed25519 release signature -- users verify with
// `npm audit signatures` instead of a key we have to guard forever.
if (doPublish) {
  const publishArgs = ["publish", "--access", "public"];
  const canAttest = process.env.GITHUB_ACTIONS === "true" && process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  if (canAttest) {
    publishArgs.push("--provenance");
  } else if (!dryRunPublish) {
    console.warn(
      "Warning: publishing without provenance. Run this from GitHub Actions with\n" +
      "`permissions: { id-token: write }` so npm can attest where the build came from.",
    );
  }
  if (dryRunPublish) publishArgs.push("--dry-run");
  run("npm", publishArgs, { cwd: app });
  console.log(dryRunPublish ? "npm publish --dry-run complete" : "Published to npm");
}

// Self-hosted download channel: tar the staged `bivy/` dir and write a manifest
// with a sha256 install.sh verifies. The archive MUST have a top-level `bivy/`
// entry — install.sh extracts and then requires `<stage>/bivy` (see install.sh
// "did not contain a bivy/ directory"). `-C tmp bivy` produces exactly that.
if (packDir) {
  fs.mkdirSync(packDir, { recursive: true });
  const tarball = path.join(packDir, "bivy-latest.tar.gz");
  const manifestPath = path.join(packDir, "bivy-latest.json");
  run("tar", ["-czf", tarball, "-C", tmp, "bivy"]);
  const sha256 = crypto.createHash("sha256").update(fs.readFileSync(tarball)).digest("hex");
  // Commit: the CI SHA when present, else the working tree's HEAD. builtAt is
  // stamped at pack time. The artifact URL is where install.sh will fetch it;
  // override via BIVY_ARTIFACT_URL for a staging/preview download host.
  const commit =
    process.env.GITHUB_SHA ||
    process.env.RENDER_GIT_COMMIT ||
    spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim() ||
    "";
  const manifest = {
    name: releasePkg.name,
    version: releasePkg.version,
    commit,
    builtAt: new Date().toISOString(),
    artifact: process.env.BIVY_ARTIFACT_URL || "https://bivy.sh/downloads/bivy-latest.tar.gz",
    sha256,
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Packed ${tarball} (sha256 ${sha256})`);
  console.log(`Wrote  ${manifestPath}`);
}

console.log(`Built ${releasePkg.name}@${releasePkg.version}`);
if (!doPublish && !packDir) {
  console.log("Not published. Use `npm run publish:npm` (or --dry-run) to publish.");
}

fs.rmSync(tmp, { recursive: true, force: true });
