#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
/**
 * Build the `bivy` release artifact.
 *
 * Compiles src/ to dist/, then stages a curated package directory containing
 * only what a packaged install needs: dist/, bin/, web/ (the built app), public/qr.js, package
 * metadata, README and LICENSE. It intentionally excludes src/, deploy/, the
 * hosted services, tests, and internal docs.
 *
 * Releases ship as self-contained per-platform archives on GitHub
 * (scripts/release-archives.mjs). `--pack` also writes one platform-independent
 * tarball + manifest, for images that install Bivy on a Node they bring.
 *
 *   pnpm run build:release         stage the package only
 *   node scripts/build-release.mjs --archives <dir> [--targets all|host|id,...]
 *                                  write self-contained per-platform archives,
 *                                  SHA256SUMS and manifest.json for GitHub
 *                                  Releases (see scripts/release-archives.mjs)
 *   node scripts/build-release.mjs --pack <dir>
 *                                  stage and write <dir>/bivy-latest.tar.gz +
 *                                  bivy-latest.json
 *   node scripts/build-release.mjs --without-web
 *                                  leave out the built web app (relay-only nodes)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { curateManifest } from "./release-manifest.mjs";
import { buildArchives, resolveTargets } from "./release-archives.mjs";
import { assertReleaseLockAged } from "./release-lock-age.mjs";

const argv = process.argv.slice(2);
/** Read the value that follows a `--flag` on the command line (or undefined). */
function argValue(flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}
// Where to emit the platform-independent tarball + manifest. Empty = don't.
const packDir = argValue("--pack");
// Where to write the per-platform GitHub release archives. Empty = don't.
const archivesDir = argValue("--archives");
const archiveTargets = resolveTargets(argValue("--targets") ?? "all");

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
for (const file of ["hosted-endpoints.mjs", "hosted-endpoints.d.mts", "agent-bridges.mjs", "agent-bridges.d.mts"]) {
  fs.copyFileSync(path.join(root, "src", file), path.join(root, "dist", file));
}

// The isolated preview header reuses the canonical design system, not a fork.
for (const [source, target] of [["packages/ui/tokens.css", "tokens.css"], ["packages/web/src/styles.css", "styles.css"]]) {
  fs.copyFileSync(path.join(root, source), path.join(root, "dist/apps", target));
}
// `bivy widget shot` renders a widget in the same frame the app uses.
fs.mkdirSync(path.join(root, "dist/widgets"), { recursive: true });
fs.copyFileSync(path.join(root, "packages/web/public/widget-frame.html"), path.join(root, "dist/widgets/widget-frame.html"));
// macOS desktop previews compile their helper from source on the Mac that runs them.
fs.copyFileSync(path.join(root, "src/apps/macos-display.swift"), path.join(root, "dist/apps/macos-display.swift"));

// The control plane serves the web app to relay-connected nodes, but a node
// reached directly (`bivy tailscale`) has no control plane, so the release ships
// the built app under web/ for the node's direct listener (src/web-app.ts), with
// the root icons the app and its manifest reference. The CLI also needs
// public/qr.js for `bivy link`/setup QR rendering.
// Disposable runners are always relay-connected, so their image skips it (--without-web).
fs.mkdirSync(app, { recursive: true });
if (!argv.includes("--without-web")) {
  run("pnpm", ["run", "build:web"]);
  copy("packages/web/dist", "web");
  for (const icon of ["apple-touch-icon.png", "icon-192.png", "icon-512.png", "icon.svg", "tent-logo.png"]) {
    copy(`services/control-plane/public/${icon}`, `web/${icon}`);
  }
}
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

// Curate the staged manifest: allowlist the scripts that reference only shipped
// paths (bin/, dist/), drop devDependencies and workspaces, prune mobile-only
// deps, and repoint start/dev at dist. Allowlisting (not denylisting) means a new
// dev-only script never silently ships broken — see scripts/release-manifest.mjs
// and issue #7. The `prepare`/`prepublishOnly` scripts drop out of the allowlist:
// `prepare` runs a dev-only git-hook cleanup that npm would auto-run on install
// (MODULE_NOT_FOUND in a packaged install), and `prepublishOnly` only guards a
// stray root publish — this staged dir is the sanctioned publish path.
const pkgPath = path.join(app, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const releaseReadme = fs.readFileSync(path.join(app, "README.md"), "utf8");
const curatedPkg = curateManifest(pkg, releaseReadme);
fs.writeFileSync(pkgPath, `${JSON.stringify(curatedPkg, null, 2)}\n`);
// The --pack tarball is installed with npm on the target, so it carries a lock.
if (packDir) {
  run("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: app });
  await assertReleaseLockAged(path.join(app, "package-lock.json"));
}

const releasePkg = JSON.parse(fs.readFileSync(path.join(app, "package.json"), "utf8"));

const commit =
  process.env.GITHUB_SHA ||
  process.env.RENDER_GIT_COMMIT ||
  spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout?.trim() ||
  "";

if (archivesDir) {
  await buildArchives({ app, outDir: path.resolve(archivesDir), targets: archiveTargets, commit });
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
  // Commit (above): the CI SHA when present, else the working tree's HEAD, else
  // empty (a Docker build stage has neither git nor .git; the workflow passes the
  // SHA in via GITHUB_SHA). builtAt is stamped at pack time. The artifact URL is
  // where install.sh will fetch it; override via BIVY_ARTIFACT_URL for a
  // staging/preview download host.
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
if (!packDir && !archivesDir) {
  console.log("Staged only. Pass --archives <dir> to write release archives.");
}

fs.rmSync(tmp, { recursive: true, force: true });
