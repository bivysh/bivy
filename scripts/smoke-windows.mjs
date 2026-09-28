#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
/**
 * Windows-only checks for an installed Bivy (run by smoke-release.mjs after the
 * global npm install). Each one covers a code path that exists only on Windows:
 *
 *   1. Arguments survive npm's real .cmd shims — how every agent CLI, npx and
 *      npm itself are installed there — both global and node_modules/.bin.
 *   2. killProcessTree reaches the node.exe a shim's cmd.exe started.
 *   3. `bivy service install` registers a logon task whose supervisor brings the
 *      node up; `bivy stop` takes it down; `bivy service uninstall` removes it.
 *
 * Usage: node scripts/smoke-windows.mjs <path to the installed bivy command>
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { killProcessTree, portableSpawn, portableSpawnSync } from "../src/portable-process.mjs";

if (process.platform !== "win32") throw new Error("smoke-windows.mjs only runs on Windows");
const bivy = process.argv[2];
if (!bivy) throw new Error("Usage: node scripts/smoke-windows.mjs <installed bivy command>");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bivy windows smoke "));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function npm(args, cwd) {
  const result = portableSpawnSync("npm", args, { cwd, encoding: "utf8", timeout: 120_000 });
  assert.equal(result.status, 0, `npm ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
}

// A package whose bin echoes its argv, installed the two ways npm writes shims.
// The temp path contains spaces on purpose.
const pkg = path.join(tmp, "echo-pkg");
fs.mkdirSync(pkg);
fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "bivy-echo", version: "1.0.0", bin: { "bivy-echo": "echo.js", "bivy-hold": "hold.js" } }));
fs.writeFileSync(path.join(pkg, "echo.js"), "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
fs.writeFileSync(path.join(pkg, "hold.js"), "#!/usr/bin/env node\nprocess.stdout.write(`${process.pid}\\n`);\nsetInterval(() => {}, 1000);\n");
const globalPrefix = path.join(tmp, "global");
npm(["install", "--global", "--prefix", globalPrefix, pkg, "--no-audit", "--no-fund"], tmp);
const project = path.join(tmp, "project");
fs.mkdirSync(project);
fs.writeFileSync(path.join(project, "package.json"), "{\"name\":\"project\",\"private\":true}");
npm(["install", pkg, "--no-audit", "--no-fund", "--install-links"], project);

// The last one would run `echo INJECTED` if the shim's own parse could see an
// unescaped quote — agent prompts travel as arguments.
const tricky = ["plain", "", "a b", 'x"y', "&calc", "a|b", "<in>", "(paren)", "caret^", "bang!", "100%", "semi;colon", "C:\\dir\\", "trail\\\\", 'q"&echo INJECTED&"q'];
for (const dir of [globalPrefix, path.join(project, "node_modules", ".bin")]) {
  const result = portableSpawnSync("bivy-echo", tricky, { encoding: "utf8", env: { ...process.env, PATH: `${dir};${process.env.PATH}` } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), tricky, `arguments changed through ${dir}`);
}
console.log("Windows .cmd shims: arguments round-trip (global and node_modules/.bin)");

// The shim's cmd.exe is the direct child; the long-lived node.exe is its child.
const held = portableSpawn("bivy-hold", [], { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, PATH: `${globalPrefix};${process.env.PATH}` } });
const heldPid = await new Promise((resolve, reject) => {
  held.stdout.once("data", (chunk) => resolve(Number(String(chunk).trim())));
  held.once("error", reject);
});
assert.ok(alive(heldPid));
assert.ok(killProcessTree(held.pid));
for (let i = 0; i < 20 && alive(heldPid); i++) await sleep(250);
assert.ok(!alive(heldPid), "killProcessTree left the shim's node.exe running");
console.log("Windows process tree: killing a shim ends the agent it started");

// Service lifecycle, isolated from any real install on this machine.
const port = await new Promise((resolve) => {
  const server = net.createServer().listen(0, "127.0.0.1", () => {
    const { port: free } = server.address();
    server.close(() => resolve(free));
  });
});
const env = { ...process.env, BIVY_DATA_DIR: path.join(tmp, "data"), PORT: String(port) };
const cli = (...args) => portableSpawnSync(bivy, args, { encoding: "utf8", env, timeout: 120_000 });
const healthy = async () => {
  try { return (await fetch(`http://127.0.0.1:${port}/healthz`)).status < 500; } catch { return false; }
};
async function waitFor(check, what, ms = 60_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(500);
  }
  const log = path.join(env.BIVY_DATA_DIR, "node.log");
  throw new Error(`${what} within ${ms / 1000}s\n${fs.existsSync(log) ? fs.readFileSync(log, "utf8").slice(-4000) : "(no node.log)"}`);
}

try {
  const installed = cli("service", "install");
  assert.equal(installed.status, 0, `bivy service install failed:\n${installed.stdout}\n${installed.stderr}`);
  await waitFor(healthy, "the scheduled task did not bring the node up");
  assert.match(cli("service", "status").stdout, /scheduled task \(running\)/);
  const status = cli("status", "--json");
  assert.equal(status.status, 0, `bivy status reported the node down:\n${status.stdout}\n${status.stderr}`);
  console.log(`Windows service: node reachable on port ${port} via the logon task`);

  assert.equal(cli("stop").status, 0);
  await waitFor(async () => !(await healthy()), "bivy stop left the node running", 20_000);
  assert.match(cli("service", "status").stdout, /scheduled task \(stopped\)/);
  console.log("Windows service: bivy stop ends the node");
} finally {
  const removed = cli("service", "uninstall");
  const query = portableSpawnSync("schtasks", ["/Query", "/TN", "Bivy"], { stdio: "ignore" });
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  assert.equal(removed.status, 0, `bivy service uninstall failed:\n${removed.stdout}\n${removed.stderr}`);
  assert.notEqual(query.status, 0, "bivy service uninstall left the scheduled task registered");
}
console.log("Windows service: uninstall removes the task");
