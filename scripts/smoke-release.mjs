// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
/**
 * Clean-consumer smoke test for the exact curated npm artifact. CI runs this on
 * Ubuntu and macOS so release packaging cannot silently depend on the checkout,
 * devDependencies, or one operating system's node_modules layout.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-release-smoke-"));
const releaseDir = path.join(tmp, "release");
const extracted = path.join(tmp, "extracted");
const packs = path.join(tmp, "packs");
const consumer = path.join(tmp, "consumer");
const globalPrefix = path.join(tmp, "global");

// Every step here is a blocking spawnSync, so a wedged child (an npm install
// that stalls on the registry in a sandboxed/offline environment) would hang the
// whole smoke test indefinitely — the exact "packaged-install check never
// returns" freeze. Give each command a hard timeout with a SIGKILL escalation so
// a hang fails loudly in minutes instead of blocking forever.
const DEFAULT_STEP_TIMEOUT_MS = 10 * 60 * 1000;

function run(command, args, options = {}) {
  const { capture, timeout, ...spawnOptions } = options;
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
    timeout: timeout ?? DEFAULT_STEP_TIMEOUT_MS,
    killSignal: "SIGKILL",
    ...spawnOptions,
  });
  if (result.error?.code === "ETIMEDOUT" || result.signal === "SIGKILL") {
    const detail = capture ? `\n${result.stdout ?? ""}\n${result.stderr ?? ""}` : "";
    throw new Error(`${command} ${args.join(" ")} timed out after ${timeout ?? DEFAULT_STEP_TIMEOUT_MS}ms${detail}`);
  }
  if (result.status !== 0) {
    const detail = capture ? `\n${result.stdout ?? ""}\n${result.stderr ?? ""}` : "";
    throw new Error(`${command} ${args.join(" ")} failed (${result.status})${detail}`);
  }
  return result.stdout ?? "";
}

try {
  fs.mkdirSync(releaseDir, { recursive: true });
  fs.mkdirSync(extracted, { recursive: true });
  fs.mkdirSync(packs, { recursive: true });
  fs.mkdirSync(consumer, { recursive: true });
  fs.mkdirSync(globalPrefix, { recursive: true });

  run(process.execPath, [path.join(root, "scripts/build-release.mjs"), "--pack", releaseDir]);
  run("tar", ["-xzf", path.join(releaseDir, "bivy-latest.tar.gz"), "-C", extracted]);

  const app = path.join(extracted, "bivy");
  const staged = JSON.parse(fs.readFileSync(path.join(app, "package.json"), "utf8"));
  if (staged.readmeFilename !== "README.md" || !staged.readme?.includes("# Bivy")) {
    throw new Error("staged npm registry metadata is missing the README");
  }
  if (staged.bundledDependencies?.includes("@earendil-works/pi-coding-agent")) {
    throw new Error("Pi must be installed as an ordinary agent dependency, not embedded in the Bivy package");
  }

  const packedJson = run("npm", ["pack", app, "--pack-destination", packs, "--json"], { capture: true });
  const packed = JSON.parse(packedJson)[0];
  if (!packed?.filename) throw new Error("npm pack did not report a tarball");
  fs.writeFileSync(path.join(consumer, "package.json"), `${JSON.stringify({ name: "bivy-release-smoke", private: true }, null, 2)}\n`);
  const tarball = path.join(packs, packed.filename);

  // install.sh uses npm's global layout. A project-local install can hoist an
  // embedded dependency and conceal missing files in its transitive packages,
  // which is how the broken thin Pi bundle escaped the original smoke test.
  run("npm", ["install", "--global", tarball, "--prefix", globalPrefix, "--no-audit", "--no-fund", "--prefer-offline"]);
  const globalBivy = path.join(globalPrefix, "bin", "bivy");
  const globalVersion = run(globalBivy, ["--version"], { capture: true }).trim();
  if (globalVersion !== staged.version) throw new Error(`global CLI version ${globalVersion} != package ${staged.version}`);
  const globalPiManifest = path.join(globalPrefix, "lib", "node_modules", "@bivy", "bivy", "node_modules", "@earendil-works", "pi-coding-agent", "package.json");
  if (!fs.existsSync(globalPiManifest)) throw new Error("global install did not resolve Pi as an ordinary dependency");

  run("npm", ["install", tarball, "--no-fund", "--prefer-offline"], { cwd: consumer });

  const bivy = path.join(consumer, "node_modules", ".bin", "bivy");
  const version = run(bivy, ["--version"], { cwd: consumer, capture: true }).trim();
  if (version !== staged.version) throw new Error(`CLI version ${version} != package ${staged.version}`);
  const agents = run(bivy, ["agents", "--json"], { cwd: consumer, capture: true });
  if (!agents.includes('"id": "pi"') || !agents.includes('"installed": true')) {
    throw new Error("packaged CLI did not discover its built-in Pi runtime");
  }

  const bivyRoot = path.join(consumer, "node_modules", "@bivy", "bivy");
  let dependencyRoot = bivyRoot;
  let piManifest;
  while (dependencyRoot !== path.dirname(dependencyRoot)) {
    const candidate = path.join(dependencyRoot, "node_modules", "@earendil-works", "pi-coding-agent", "package.json");
    if (fs.existsSync(candidate)) {
      piManifest = candidate;
      break;
    }
    dependencyRoot = path.dirname(dependencyRoot);
  }
  if (!piManifest) throw new Error("local install did not resolve Pi as an ordinary dependency");
  const requireFromPi = createRequire(piManifest);
  function resolvedPackageVersion(name) {
    let dir = path.dirname(requireFromPi.resolve(name));
    while (dir !== path.dirname(dir)) {
      const manifest = path.join(dir, "package.json");
      if (fs.existsSync(manifest)) {
        const candidate = JSON.parse(fs.readFileSync(manifest, "utf8"));
        if (candidate.name === name) return candidate.version;
      }
      dir = path.dirname(dir);
    }
    throw new Error(`could not find ${name}'s resolved package manifest`);
  }
  const braceVersion = resolvedPackageVersion("brace-expansion");
  const undiciVersion = resolvedPackageVersion("undici");
  if (braceVersion !== "5.0.9" || undiciVersion !== "8.9.0") {
    throw new Error(`unsafe bundled dependency versions: brace-expansion ${braceVersion}, undici ${undiciVersion}`);
  }

  // Pi's published shrinkwrap makes npm audit report its original transitive
  // versions even after Bivy's postinstall replaces the vulnerable files.
  // Check the installed bytes above; root-security separately gates all other
  // high/critical advisories through scripts/audit-prod.mjs.
  console.log(`release smoke passed on ${process.platform}: @bivy/bivy@${version}, patched Pi installed as an ordinary agent dependency`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
