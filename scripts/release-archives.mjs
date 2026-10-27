// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
/**
 * Self-contained release archives: one per platform, each holding the curated
 * app, its production node_modules for that platform, and a pinned Node runtime.
 * Installing one needs no Node, npm or registry on the machine.
 *
 *   bivy-<version>-<target>/
 *     bin/bivy             launcher: runs app/bin/bivy.mjs on runtime/bin/node
 *     app/                 the staged package (bin, dist, web, public) + node_modules
 *     runtime/             Node (bin/node, bin/npm, bin/npx, lib/node_modules/npm)
 *     bivy-archive.json    { version, target, node }
 *
 * Every target builds on one Linux host: production dependencies are pure JS
 * apart from node-pty, whose prebuilt binary npm picks per `--os`/`--cpu`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";

/** Platforms a release ships. Adding one is a row here. */
export const ARCHIVE_TARGETS = [
  { id: "linux-x64", os: "linux", cpu: "x64" },
  { id: "linux-arm64", os: "linux", cpu: "arm64" },
  { id: "darwin-x64", os: "darwin", cpu: "x64" },
  { id: "darwin-arm64", os: "darwin", cpu: "arm64" },
];

/** The Node release bundled into every archive. */
export const NODE_VERSION = "22.23.3";

/** Only what the runtime needs; headers, docs and corepack stay out. */
const RUNTIME_FILES = ["bin/node", "bin/npm", "bin/npx", "lib/node_modules/npm", "LICENSE"];

const LAUNCHER = `#!/bin/sh
# Runs the Bivy CLI on the Node runtime shipped next to it.
self="$0"
while [ -L "$self" ]; do
  link="$(readlink "$self")"
  case "$link" in
    /*) self="$link" ;;
    *) self="$(dirname "$self")/$link" ;;
  esac
done
# Logical, not physical: keep an installed path's \`current\` symlink in it, so
# what Bivy writes to disk (service unit, shims) survives the next update.
root="$(cd "$(dirname "$self")/.." && pwd)"
BIVY_ARCHIVE_ROOT="$root" exec "$root/runtime/bin/node" "$root/app/bin/bivy.mjs" "$@"
`;

/** The target matching this machine, or undefined. */
export function hostTarget() {
  return ARCHIVE_TARGETS.find((t) => t.os === process.platform && t.cpu === process.arch);
}

/** "all", "host", or a comma list of target ids. */
export function resolveTargets(spec = "all") {
  if (spec === "all") return ARCHIVE_TARGETS;
  if (spec === "host") {
    const host = hostTarget();
    if (!host) throw new Error(`no release archive target for ${process.platform}-${process.arch}`);
    return [host];
  }
  return spec.split(",").map((id) => {
    const target = ARCHIVE_TARGETS.find((t) => t.id === id);
    if (!target) throw new Error(`unknown archive target "${id}" (known: ${ARCHIVE_TARGETS.map((t) => t.id).join(", ")})`);
    return target;
  });
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${res.status ?? res.signal})`);
}

function runAsync(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", ...opts });
    child.once("error", reject);
    child.once("close", (code, signal) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} failed (${code ?? signal})`))));
  });
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

/** Download (once) and verify the Node build for a target against nodejs.org's SHASUMS256. */
async function nodeRuntime(target, cacheDir) {
  const name = `node-v${NODE_VERSION}-${target.os}-${target.cpu}`;
  const dir = path.join(cacheDir, name);
  if (fs.existsSync(path.join(dir, "bin", "node"))) return dir;
  const base = `https://nodejs.org/dist/v${NODE_VERSION}`;
  const sums = path.join(cacheDir, `SHASUMS256-v${NODE_VERSION}.txt`);
  const file = `${name}.tar.gz`;
  const expected = fs.readFileSync(sums, "utf8").split("\n").find((line) => line.endsWith(`  ${file}`))?.split(" ")[0];
  if (!expected) throw new Error(`${file} is not listed in Node ${NODE_VERSION}'s SHASUMS256.txt`);
  const tarball = path.join(cacheDir, file);
  await download(`${base}/${file}`, tarball);
  const actual = sha256File(tarball);
  if (actual !== expected) throw new Error(`${file}: sha256 ${actual} does not match nodejs.org's ${expected}`);
  await runAsync("tar", ["-xzf", tarball, "-C", cacheDir]);
  fs.rmSync(tarball);
  return dir;
}

/**
 * Build an archive per target from a staged app dir (see build-release.mjs).
 * Writes `<outDir>/bivy-<version>-<target>.tar.gz`, `SHA256SUMS` and
 * `manifest.json`, and returns the manifest.
 */
export async function buildArchives({ app, outDir, targets = ARCHIVE_TARGETS, commit = "", cacheDir }) {
  const pkg = JSON.parse(fs.readFileSync(path.join(app, "package.json"), "utf8"));
  const version = pkg.version;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-archives-"));
  const cache = cacheDir ?? path.join(os.homedir(), ".cache", "bivy-release", "node");
  fs.mkdirSync(cache, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  try {
    // One lockfile for every target, so they all ship the same dependency versions.
    const lockDir = path.join(work, "lock");
    fs.mkdirSync(lockDir);
    fs.copyFileSync(path.join(app, "package.json"), path.join(lockDir, "package.json"));
    run("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: lockDir });

    const sums = path.join(cache, `SHASUMS256-v${NODE_VERSION}.txt`);
    if (!fs.existsSync(sums)) await download(`https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt`, sums);

    // Targets are independent; building them together roughly quarters release time.
    const built = await Promise.all(targets.map(async (target) => {
      const name = `bivy-${version}-${target.id}`;
      const root = path.join(work, name);
      fs.cpSync(app, path.join(root, "app"), { recursive: true, verbatimSymlinks: true });
      fs.copyFileSync(path.join(lockDir, "package-lock.json"), path.join(root, "app", "package-lock.json"));
      // No dependency needs an install script; node-pty ships prebuilt per platform.
      const install = runAsync("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error", `--os=${target.os}`, `--cpu=${target.cpu}`], { cwd: path.join(root, "app") });
      const [node] = await Promise.all([nodeRuntime(target, cache), install]);
      for (const rel of RUNTIME_FILES) {
        fs.cpSync(path.join(node, rel), path.join(root, "runtime", rel), { recursive: true, verbatimSymlinks: true });
      }
      fs.mkdirSync(path.join(root, "bin"));
      fs.writeFileSync(path.join(root, "bin", "bivy"), LAUNCHER, { mode: 0o755 });
      fs.writeFileSync(path.join(root, "bivy-archive.json"), `${JSON.stringify({ version, target: target.id, node: NODE_VERSION }, null, 2)}\n`);

      const file = `${name}.tar.gz`;
      await runAsync("tar", ["-czf", path.join(outDir, file), "-C", work, name]);
      const entry = { file, sha256: sha256File(path.join(outDir, file)), size: fs.statSync(path.join(outDir, file)).size };
      console.log(`Packed ${file} (${(entry.size / 1e6).toFixed(1)} MB)`);
      return [target.id, entry];
    }));
    const archives = Object.fromEntries(built);

    const manifest = { name: pkg.name, version, commit, builtAt: new Date().toISOString(), node: NODE_VERSION, archives };
    fs.writeFileSync(path.join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    fs.writeFileSync(path.join(outDir, "SHA256SUMS"), Object.values(archives).map((a) => `${a.sha256}  ${a.file}\n`).join(""));
    return manifest;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
