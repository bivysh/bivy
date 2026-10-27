// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
/**
 * Smoke-test this machine's self-contained release archive from a directory
 * written by `build-release.mjs --archives <dir>`. It runs with no system Node
 * on PATH, so anything that still leans on one fails here.
 *
 *   node scripts/smoke-archive.mjs <archives-dir> [--bridges]
 *
 * --bridges also installs the agent SDK bridges through the archive's own npm
 * (from the registry, so slower) and checks Pi is found through them.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { hostTarget } from "./release-archives.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = process.argv[2];
const withBridges = process.argv.includes("--bridges");
if (!dir) throw new Error("Usage: node scripts/smoke-archive.mjs <archives-dir>");
const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
const target = hostTarget();
const entry = target && manifest.archives[target.id];
if (!entry) throw new Error(`no archive for ${process.platform}-${process.arch} in ${dir}/manifest.json`);

const tarball = path.join(dir, entry.file);
const sha256 = crypto.createHash("sha256").update(fs.readFileSync(tarball)).digest("hex");
if (sha256 !== entry.sha256) throw new Error(`${entry.file}: sha256 ${sha256} does not match the manifest`);
if (!fs.readFileSync(path.join(dir, "SHA256SUMS"), "utf8").includes(`${sha256}  ${entry.file}`)) {
  throw new Error(`${entry.file} is missing from SHA256SUMS`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-archive-smoke-"));
// Only system tools; no node, npm or npx from the host.
const env = { HOME: tmp, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", BIVY_DATA_DIR: path.join(tmp, "data") };

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: "utf8", env, timeout: 120_000, ...opts });
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${res.status ?? res.signal})\n${res.stdout}\n${res.stderr}`);
  return res.stdout.trim();
}

/** Start the archived daemon and wait for /healthz: proves every runtime import ships. */
async function daemonServes(node, app) {
  const port = await new Promise((resolve) => {
    const server = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
  fs.mkdirSync(path.join(tmp, "ws"), { recursive: true });
  const daemon = spawn(node, [path.join(app, "dist", "server.js")], {
    env: { ...env, PORT: String(port), BIVY_WORKSPACE: path.join(tmp, "ws"), BIVY_REQUIRE_LOCAL_AUTH: "0" },
    stdio: ["ignore", "pipe", "pipe"],
    // Its own process group, so its helpers die with it before cleanup.
    detached: true,
  });
  let log = "";
  daemon.stdout.on("data", (d) => { log += d; });
  daemon.stderr.on("data", (d) => { log += d; });
  try {
    for (let i = 0; i < 60; i++) {
      if (daemon.exitCode !== null) break;
      const ok = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.ok, () => false);
      if (ok) return;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`archived daemon did not serve /healthz within 30s (exit ${daemon.exitCode})\n${log.slice(-4000)}`);
  } finally {
    // Wait for it to exit so cleanup doesn't race its writes into the data dir.
    if (daemon.exitCode === null) await new Promise((r) => { daemon.once("exit", r); process.kill(-daemon.pid, "SIGKILL"); });
  }
}

try {
  run("tar", ["-xzf", tarball, "-C", tmp]);
  const install = path.join(tmp, entry.file.replace(/\.tar\.gz$/, ""));
  const info = JSON.parse(fs.readFileSync(path.join(install, "bivy-archive.json"), "utf8"));
  if (info.version !== manifest.version || info.target !== target.id) throw new Error(`bivy-archive.json describes ${info.version} ${info.target}`);

  // The launcher must resolve its own location through a symlink, as ~/.local/bin/bivy will be.
  const link = path.join(tmp, "bivy");
  fs.symlinkSync(path.join(install, "bin", "bivy"), link);
  const version = run(link, ["--version"]);
  if (version !== manifest.version) throw new Error(`launcher reports ${version}, archive is ${manifest.version}`);

  const node = path.join(install, "runtime", "bin", "node");
  if (run(node, ["--version"]) !== `v${manifest.node}`) throw new Error("bundled Node is not the pinned version");
  // Agent bridges and npm-distributed agents install through the bundled npm.
  run(path.join(install, "runtime", "bin", "npm"), ["--version"], { env: { ...env, PATH: `${path.dirname(node)}:${env.PATH}` } });
  // Terminal support from the archive's own prebuilt node-pty.
  run(node, [path.join(root, "scripts/smoke-pty.mjs"), path.join(install, "app")]);
  for (const scope of ["@anthropic-ai", "@earendil-works"]) {
    if (fs.existsSync(path.join(install, "app", "node_modules", scope))) throw new Error(`archive ships ${scope} packages; agent bridges install on demand`);
  }
  await daemonServes(node, path.join(install, "app"));
  if (withBridges) {
    run(link, ["agents:install", "--bridges"], { timeout: 600_000 });
    // As the node does, look for bridge CLIs (Pi's `pi`) in the bridges' bin.
    const bridgeEnv = { ...env, PATH: `${path.join(env.BIVY_DATA_DIR, "bridges", "node_modules", ".bin")}:${env.PATH}` };
    const agents = JSON.parse(run(link, ["agents", "--json"], { env: bridgeEnv }));
    const pi = (Array.isArray(agents) ? agents : agents.agents ?? []).find((agent) => agent.id === "pi");
    if (!pi?.installed) throw new Error("the archive's CLI did not find Pi through its installed bridge");
    // Bridges drive the operator's own agent CLI, so the Claude SDK's bundled
    // per-platform binary (~200 MB) must not be installed.
    const anthropic = fs.readdirSync(path.join(env.BIVY_DATA_DIR, "bridges", "node_modules", "@anthropic-ai"));
    if (anthropic.some((name) => name.startsWith("claude-agent-sdk-"))) throw new Error(`bridge install pulled in the Claude SDK's bundled binary: ${anthropic.join(", ")}`);
  }
  console.log(`archive smoke passed: ${entry.file} (${(entry.size / 1e6).toFixed(1)} MB), Node ${manifest.node}, daemon serves${withBridges ? ", bridges install" : ""}, no system Node`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
