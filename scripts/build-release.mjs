#!/usr/bin/env node
// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
/**
 * Build the closed-source-ish install artifact served by bivy.sh/install.sh.
 *
 * It packages compiled JS (dist/), static assets, the CLI, package metadata, and
 * docs needed to run Bivy. It intentionally does not include src/, mobile/,
 * deploy/, hosted services, or internal docs.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, sign as signData } from "node:crypto";
import { spawnSync } from "node:child_process";

const argv = process.argv.slice(2);
const doPublish = argv.includes("--publish");
const dryRunPublish = argv.includes("--dry-run");

const root = path.resolve(new URL("..", import.meta.url).pathname);
// The marketing/install site lives in its own repo (bivysh/bivy-site). Release
// artifacts must land in that checkout's publish directory, so the output root
// is configurable. Defaults to ./site for in-repo builds and local testing.
const siteDir = process.env.BIVY_SITE_DIR ? path.resolve(process.env.BIVY_SITE_DIR) : path.join(root, "site");
const outDir = path.join(siteDir, "downloads");
const artifact = path.join(outDir, "bivy-latest.tar.gz");
const manifest = path.join(outDir, "bivy-latest.json");
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
// The artifact ships no `packages/` workspaces (the web PWA is built/served by
// the control plane, not the node). Drop the monorepo `workspaces` field and the
// workspace-scoped scripts so they don't dangle in the installed package.
delete pkg.workspaces;
for (const s of ["build:web", "dev:web", "test:core", "typecheck:web"]) delete pkg.scripts?.[s];
fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
run("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: app });

fs.mkdirSync(outDir, { recursive: true });
fs.rmSync(artifact, { force: true });
// Disable macOS AppleDouble / extended attributes so Linux GNU tar installs are quiet and portable.
run("tar", ["--no-xattrs", "-czf", artifact, "bivy"], {
  cwd: tmp,
  env: { ...process.env, COPYFILE_DISABLE: "1" },
});
const releasePkg = JSON.parse(fs.readFileSync(path.join(app, "package.json"), "utf8"));
const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
const sha256 = createHash("sha256").update(fs.readFileSync(artifact)).digest("hex");
const manifestBody = {
  name: releasePkg.name ?? "bivy",
  version: releasePkg.version ?? "0.0.0",
  commit: git.status === 0 ? git.stdout.trim() : undefined,
  builtAt: new Date().toISOString(),
  artifact: "https://bivy.sh/downloads/bivy-latest.tar.gz",
  sha256,
};
const signingKey = process.env.BIVY_RELEASE_SIGNING_KEY_PEM || (process.env.BIVY_RELEASE_SIGNING_KEY_FILE ? fs.readFileSync(process.env.BIVY_RELEASE_SIGNING_KEY_FILE, "utf8") : "");
const verifyKey = process.env.BIVY_RELEASE_VERIFY_KEY_PEM || (process.env.BIVY_RELEASE_VERIFY_KEY_FILE ? fs.readFileSync(process.env.BIVY_RELEASE_VERIFY_KEY_FILE, "utf8") : "");
if (signingKey) {
  const canonical = JSON.stringify(manifestBody);
  manifestBody.signature = {
    alg: "Ed25519",
    value: signData(null, Buffer.from(canonical), signingKey).toString("base64"),
    payload: "manifest-json-without-signature",
  };
}
fs.writeFileSync(manifest, `${JSON.stringify(manifestBody, null, 2)}\n`);

// Optionally publish the curated staging dir to npm. The staged package.json has
// already been corrected for a packaged install (start/dev -> node dist/server.js,
// the dev-only `prepare` git-hook script removed, mobile deps pruned), and the
// staging dir has no node_modules, so `npm publish` here ships exactly the same
// files as the tarball above. Run from `app`, not the repo root, to avoid the
// `prepare` MODULE_NOT_FOUND trap and shipping src/, services/, docs/, etc.
if (doPublish) {
  const publishArgs = ["publish", "--access", "public"];
  if (dryRunPublish) publishArgs.push("--dry-run");
  run("npm", publishArgs, { cwd: app });
  console.log(dryRunPublish ? "npm publish --dry-run complete" : "Published to npm");
}

fs.rmSync(tmp, { recursive: true, force: true });

// The site publishes ./site, so bivy.sh/install.sh is served from
// site/install.sh. Copy the canonical root install.sh into place on every build
// so the served installer can never drift from the tested one.
const servedInstaller = path.join(siteDir, "install.sh");
let installerText = fs.readFileSync(path.join(root, "install.sh"), "utf8");
if (verifyKey) {
  const escaped = verifyKey.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\$/g, "\\$").replace(/`/g, "\\`");
  const anchor = 'EMBEDDED_RELEASE_VERIFY_KEY_PEM="${BIVY_EMBEDDED_RELEASE_VERIFY_KEY_PEM:-}"';
  // Fail loudly rather than silently shipping a keyless installer: a whitespace
  // edit to that line in install.sh would otherwise make this a no-op and every
  // production install would fail closed with no signal from the build.
  if (!installerText.includes(anchor)) {
    throw new Error(
      `build-release: could not find the verify-key anchor in install.sh.\n` +
      `Expected the literal line:\n  ${anchor}\n` +
      `Fix install.sh (or this anchor) before releasing -- otherwise the served ` +
      `installer ships without the release public key and rejects every install.`,
    );
  }
  installerText = installerText.replace(anchor, `EMBEDDED_RELEASE_VERIFY_KEY_PEM="${escaped}"`);
  if (!installerText.includes(escaped)) {
    throw new Error("build-release: verify-key substitution did not take effect.");
  }
} else if (signingKey) {
  console.warn("Warning: release manifest is signed but no BIVY_RELEASE_VERIFY_KEY_PEM/_FILE was provided for the served installer.");
}
fs.writeFileSync(servedInstaller, installerText);

console.log(`Wrote ${artifact}`);
console.log(`Wrote ${manifest}`);
console.log(`Wrote ${servedInstaller}`);
