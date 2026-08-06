// SPDX-License-Identifier: FSL-1.1-ALv2
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
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-release-smoke-"));
const releaseDir = path.join(tmp, "release");
const extracted = path.join(tmp, "extracted");
const packs = path.join(tmp, "packs");
const consumer = path.join(tmp, "consumer");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    ...options,
  });
  if (result.status !== 0) {
    const detail = options.capture ? `\n${result.stdout ?? ""}\n${result.stderr ?? ""}` : "";
    throw new Error(`${command} ${args.join(" ")} failed (${result.status})${detail}`);
  }
  return result.stdout ?? "";
}

try {
  fs.mkdirSync(releaseDir, { recursive: true });
  fs.mkdirSync(extracted, { recursive: true });
  fs.mkdirSync(packs, { recursive: true });
  fs.mkdirSync(consumer, { recursive: true });

  run(process.execPath, [path.join(root, "scripts/build-release.mjs"), "--pack", releaseDir]);
  run("tar", ["-xzf", path.join(releaseDir, "bivy-latest.tar.gz"), "-C", extracted]);

  const app = path.join(extracted, "bivy");
  const staged = JSON.parse(fs.readFileSync(path.join(app, "package.json"), "utf8"));
  if (staged.readmeFilename !== "README.md" || !staged.readme?.includes("# Bivy")) {
    throw new Error("staged npm registry metadata is missing the README");
  }
  if (!staged.bundledDependencies?.includes("@earendil-works/pi-coding-agent")) {
    throw new Error("staged manifest is missing the thin pi bundle");
  }

  const packedJson = run("npm", ["pack", app, "--pack-destination", packs, "--json"], { capture: true });
  const packed = JSON.parse(packedJson)[0];
  if (!packed?.filename) throw new Error("npm pack did not report a tarball");
  // npm's pack JSON reports `bundled` on Linux but omits it on some npm/macOS
  // combinations. Validate the bundle portably after installation below by
  // resolving Pi and its repinned dependencies from the consumer project.

  fs.writeFileSync(path.join(consumer, "package.json"), `${JSON.stringify({ name: "bivy-release-smoke", private: true }, null, 2)}\n`);
  const tarball = path.join(packs, packed.filename);
  run("npm", ["install", tarball, "--no-fund"], { cwd: consumer });

  const bivy = path.join(consumer, "node_modules", ".bin", "bivy");
  const version = run(bivy, ["--version"], { cwd: consumer, capture: true }).trim();
  if (version !== staged.version) throw new Error(`CLI version ${version} != package ${staged.version}`);
  const agents = run(bivy, ["agents", "--json"], { cwd: consumer, capture: true });
  if (!agents.includes('"id": "pi"') || !agents.includes('"installed": true')) {
    throw new Error("packaged CLI did not discover its built-in Pi runtime");
  }

  const piRoot = path.join(consumer, "node_modules", "@bivy", "bivy", "node_modules", "@earendil-works", "pi-coding-agent");
  const requireFromPi = createRequire(path.join(piRoot, "package.json"));
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

  run("npm", ["audit", "--omit=dev", "--audit-level=high"], { cwd: consumer });
  console.log(`release smoke passed on ${process.platform}: @bivy/bivy@${version}, clean audit, Pi available`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
