// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
/**
 * Clean-consumer smoke test for the exact curated npm artifact. CI runs this on
 * Ubuntu and macOS so release packaging cannot silently depend on the checkout,
 * devDependencies, or one operating system's node_modules layout.
 *
 * With no arguments it builds the self-hosted artifact first. CI passes
 * `--artifact <path>` with the exact npm tarball so multiple consumer jobs can
 * test one package without rebuilding it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactIndex = process.argv.indexOf("--artifact");
if (artifactIndex >= 0 && !process.argv[artifactIndex + 1]) {
  throw new Error("--artifact requires a path to bivy-latest.tar.gz");
}
const providedArtifact = artifactIndex >= 0 ? path.resolve(process.argv[artifactIndex + 1]) : undefined;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-release-smoke-"));
const releaseDir = path.join(tmp, "release");
const extracted = path.join(tmp, "extracted");
const packs = path.join(tmp, "packs");
const consumer = path.join(tmp, "consumer");
const globalPrefix = path.join(tmp, "global");

// A wedged child (an npm install that stalls on the registry in a
// sandboxed/offline environment) must not hang the whole smoke test. Give each
// command a hard timeout with a SIGKILL escalation so it fails loudly instead.
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

function runAsync(command, args, options = {}) {
  const { timeout = DEFAULT_STEP_TIMEOUT_MS, ...spawnOptions } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: "inherit",
      detached: process.platform !== "win32",
      ...spawnOptions,
    });
    let finished = false;
    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    child.once("error", (error) => finish(error));
    child.once("close", (code, signal) => {
      if (code === 0) finish();
      else finish(new Error(`${command} ${args.join(" ")} failed (${code ?? signal ?? "unknown"})`));
    });
    const timer = setTimeout(() => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // The process exited between the timeout and kill.
      }
      finish(new Error(`${command} ${args.join(" ")} timed out after ${timeout}ms`));
    }, timeout);
  });
}

try {
  fs.mkdirSync(releaseDir, { recursive: true });
  fs.mkdirSync(extracted, { recursive: true });
  fs.mkdirSync(packs, { recursive: true });
  fs.mkdirSync(consumer, { recursive: true });
  fs.mkdirSync(globalPrefix, { recursive: true });

  // CI builds the platform-independent package once and passes the same artifact
  // to both consumer OS jobs. Local runs still build it here for convenience.
  // Besides avoiding duplicate compilation, this proves both OSes consume the
  // exact same bytes that the build job produced.
  const artifact = providedArtifact ?? path.join(releaseDir, "bivy-latest.tar.gz");
  if (providedArtifact) {
    if (!fs.existsSync(providedArtifact)) throw new Error(`release artifact does not exist: ${providedArtifact}`);
  } else {
    run(process.execPath, [path.join(root, "scripts/build-release.mjs"), "--pack", releaseDir]);
  }
  run("tar", ["-xzf", artifact, "-C", extracted]);

  // The fallback archive has a `bivy/` root; npm's canonical tarball uses
  // `package/`. Accept both so local fallback checks remain convenient while CI
  // exercises the exact registry payload.
  const app = fs.existsSync(path.join(extracted, "package", "package.json"))
    ? path.join(extracted, "package")
    : path.join(extracted, "bivy");
  const staged = JSON.parse(fs.readFileSync(path.join(app, "package.json"), "utf8"));
  if (staged.readmeFilename !== "README.md" || !staged.readme?.includes("# Bivy")) {
    throw new Error("staged npm registry metadata is missing the README");
  }
  if (staged.optionalDependencies || !staged.agentBridges?.["@earendil-works/pi-coding-agent"]) {
    throw new Error("agent bridges must ship as `agentBridges` pins, not dependencies npm installs with Bivy");
  }

  const packedJson = run("npm", ["pack", app, "--pack-destination", packs, "--json"], { capture: true });
  const packed = JSON.parse(packedJson)[0];
  if (!packed?.filename) throw new Error("npm pack did not report a tarball");
  fs.writeFileSync(path.join(consumer, "package.json"), `${JSON.stringify({ name: "bivy-release-smoke", private: true }, null, 2)}\n`);
  const tarball = path.join(packs, packed.filename);

  // install.sh uses npm's global layout; a project-local install hoists
  // differently. The layouts are independent, so exercise both concurrently
  // rather than putting two registry installs in CI's critical path in a row.
  const installs = await Promise.allSettled([
    runAsync("npm", ["install", "--global", tarball, "--prefix", globalPrefix, "--no-audit", "--no-fund", "--prefer-offline"]),
    runAsync("npm", ["install", tarball, "--no-fund", "--prefer-offline"], { cwd: consumer }),
  ]);
  const failedInstall = installs.find((result) => result.status === "rejected");
  if (failedInstall?.status === "rejected") throw failedInstall.reason;

  const globalBivy = path.join(globalPrefix, "bin", "bivy");
  const globalRoot = path.join(globalPrefix, "lib", "node_modules", "@bivy", "bivy");
  const globalVersion = run(globalBivy, ["--version"], { capture: true }).trim();
  if (globalVersion !== staged.version) throw new Error(`global CLI version ${globalVersion} != package ${staged.version}`);
  // Terminal support must be present and actually work from its prebuilt
  // binary, not just pass require.resolve().
  run(process.execPath, [path.join(root, "scripts/smoke-pty.mjs"), globalRoot]);
  // npm -g ignores --omit=optional, which is how every install used to pull in
  // every agent SDK. Nothing agent-specific may land in Bivy's own tree.
  for (const scope of ["@anthropic-ai", "@earendil-works"]) {
    if (fs.existsSync(path.join(globalRoot, "node_modules", scope))) throw new Error(`global install pulled in ${scope} packages`);
  }

  const bivy = path.join(consumer, "node_modules", ".bin", "bivy");
  const version = run(bivy, ["--version"], { cwd: consumer, capture: true }).trim();
  if (version !== staged.version) throw new Error(`CLI version ${version} != package ${staged.version}`);

  // Bridges install on demand into the node's data dir. Install them the way
  // the runner image does and check the packaged CLI finds Pi through them.
  const dataDir = path.join(tmp, "data");
  const bridges = path.join(dataDir, "bridges");
  const bridgeEnv = {
    ...process.env,
    BIVY_DATA_DIR: dataDir,
    PATH: `${path.join(bridges, "node_modules", ".bin")}${path.delimiter}${process.env.PATH ?? ""}`,
  };
  run(globalBivy, ["agents:install", "--bridges"], { env: bridgeEnv });
  const agents = run(globalBivy, ["agents", "--json"], { capture: true, env: bridgeEnv });
  if (!agents.includes('"id": "pi"') || !agents.includes('"installed": true')) {
    throw new Error("packaged CLI did not discover Pi through its installed bridge");
  }
  // Bridges drive the operator's own agent CLI, so the Claude SDK's bundled
  // per-platform binary (~200 MB) must not be installed.
  const anthropic = fs.readdirSync(path.join(bridges, "node_modules", "@anthropic-ai"));
  if (anthropic.some((name) => name.startsWith("claude-agent-sdk-"))) {
    throw new Error(`bridge install pulled in the Claude SDK's bundled binary: ${anthropic.join(", ")}`);
  }

  const piManifest = path.join(bridges, "node_modules", "@earendil-works", "pi-coding-agent", "package.json");
  if (!fs.existsSync(piManifest)) throw new Error("bridge install did not install Pi");
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
  if (braceVersion !== "5.0.12" || undiciVersion !== "8.10.2") {
    throw new Error(`unsafe bundled dependency versions: brace-expansion ${braceVersion}, undici ${undiciVersion}`);
  }

  // Pi's published shrinkwrap makes npm audit report its original transitive
  // versions even after the bridge install replaces the vulnerable files.
  // Check the installed bytes above; root-security separately gates all other
  // high/critical advisories through scripts/audit-prod.mjs.
  console.log(`release smoke passed on ${process.platform}: @bivy/bivy@${version}, no agent SDKs in the package, patched Pi bridge installed on demand`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
