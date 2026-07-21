import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { injectJsonMcpConfig, injectMcpProxyForSession, bivyProxyLauncher } from "../src/harness/mcp-inject.js";
import { agentMcpConfigTargets, isProxied } from "../src/harness/mcp-config.js";

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${(error as Error).stack ?? (error as Error).message}`);
  }
}

const launcher = bivyProxyLauncher("bivy");

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bivy-inject-"));
}

check("injects proxy into a JSON config and restores exact bytes", () => {
  const dir = tmp();
  const file = path.join(dir, ".mcp.json");
  const original = `{\n  "mcpServers": {\n    "fs": { "command": "mcp-fs", "args": ["--root", "/w"] }\n  }\n}\n`;
  fs.writeFileSync(file, original);

  const r = injectJsonMcpConfig(file, launcher);
  assert.equal(r.injected, true);
  const rewritten = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(rewritten.mcpServers.fs.command, "bivy");
  assert.equal(isProxied(rewritten.mcpServers.fs, launcher), true);

  r.restore();
  assert.equal(fs.readFileSync(file, "utf8"), original, "restore must reproduce the original bytes exactly");
  fs.rmSync(dir, { recursive: true, force: true });
});

check("no-op (safe) when file is absent", () => {
  const dir = tmp();
  const r = injectJsonMcpConfig(path.join(dir, "nope.json"), launcher);
  assert.equal(r.injected, false);
  r.restore(); // must not throw
  fs.rmSync(dir, { recursive: true, force: true });
});

check("no-op when file is not JSON", () => {
  const dir = tmp();
  const file = path.join(dir, ".mcp.json");
  fs.writeFileSync(file, "not json {{{");
  const r = injectJsonMcpConfig(file, launcher);
  assert.equal(r.injected, false);
  assert.equal(fs.readFileSync(file, "utf8"), "not json {{{", "must leave a non-JSON file untouched");
  fs.rmSync(dir, { recursive: true, force: true });
});

check("no-op when there are no stdio servers to route", () => {
  const dir = tmp();
  const file = path.join(dir, ".mcp.json");
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { remote: { url: "https://x/sse" } } }));
  const r = injectJsonMcpConfig(file, launcher);
  assert.equal(r.injected, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

check("injectMcpProxyForSession routes workspace-local .mcp.json and restores", () => {
  const ws = tmp();
  const file = path.join(ws, ".mcp.json");
  const original = JSON.stringify({ mcpServers: { fs: { command: "mcp-fs", args: [] } } }, null, 2) + "\n";
  fs.writeFileSync(file, original);

  const targets = agentMcpConfigTargets("claude", { workspace: ws, home: os.homedir() });
  assert.ok(targets.includes(file), "claude targets should include workspace .mcp.json");

  const res = injectMcpProxyForSession("claude", { workspace: ws, home: os.homedir() }, launcher);
  assert.deepEqual(res.injected, [file]);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers.fs.command, "bivy");

  res.restore();
  assert.equal(fs.readFileSync(file, "utf8"), original, "session restore reproduces original bytes");
  fs.rmSync(ws, { recursive: true, force: true });
});

check("injectMcpProxyForSession is a no-op when no config exists", () => {
  const ws = tmp();
  const res = injectMcpProxyForSession("claude", { workspace: ws, home: os.homedir() }, launcher);
  assert.deepEqual(res.injected, []);
  res.restore();
  fs.rmSync(ws, { recursive: true, force: true });
});

if (failures > 0) {
  console.error(`\n${failures} mcp-inject test(s) failed`);
  process.exit(1);
}
console.log("\nall mcp-inject tests passed");
