import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { injectJsonMcpConfig, injectMcpProxyForSession, injectBivyToolsForSession, bivyProxyLauncher } from "../src/harness/mcp-inject.js";
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

// --- Bivy tools server injection (attach_to_chat discoverability, #290) --------

check("injectBivyTools CREATES a session-local .mcp.json when absent, restore deletes it", () => {
  const ws = tmp();
  const file = path.join(ws, ".mcp.json");
  assert.equal(fs.existsSync(file), false);

  const res = injectBivyToolsForSession("codex-cli", { workspace: ws, home: os.homedir(), sessionId: "sess-1", endpoint: "http://127.0.0.1:4317" });
  assert.deepEqual(res.injected, [file]);
  const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(cfg.mcpServers.bivy.command, "bivy");
  assert.deepEqual(cfg.mcpServers.bivy.args, ["mcp-serve"]);
  assert.equal(cfg.mcpServers.bivy.env.BIVY_SESSION_ID, "sess-1");
  assert.equal(cfg.mcpServers.bivy.env.BIVY_MCP_ENDPOINT, "http://127.0.0.1:4317");

  res.restore();
  assert.equal(fs.existsSync(file), false, "restore must delete a file it created");
  fs.rmSync(ws, { recursive: true, force: true });
});

check("injectBivyTools ADDS to an existing config and restores exact original bytes", () => {
  const ws = tmp();
  const file = path.join(ws, ".mcp.json");
  const original = JSON.stringify({ mcpServers: { fs: { command: "mcp-fs", args: [] } } }, null, 2) + "\n";
  fs.writeFileSync(file, original);

  const res = injectBivyToolsForSession("gemini-generic", { workspace: ws, home: os.homedir(), sessionId: "s" });
  assert.deepEqual(res.injected, [file]);
  const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(cfg.mcpServers.fs.command, "mcp-fs", "existing servers are preserved");
  assert.equal(cfg.mcpServers.bivy.command, "bivy");
  assert.equal(cfg.mcpServers.bivy.env.BIVY_MCP_ENDPOINT, undefined, "no endpoint stamped when not provided");

  res.restore();
  assert.equal(fs.readFileSync(file, "utf8"), original, "restore reproduces the original bytes exactly");
  fs.rmSync(ws, { recursive: true, force: true });
});

check("injectBivyTools is idempotent — a pre-existing bivy server is a no-op", () => {
  const ws = tmp();
  const file = path.join(ws, ".mcp.json");
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { bivy: { command: "bivy", args: ["mcp-serve"] } } }));
  const res = injectBivyToolsForSession("generic", { workspace: ws, home: os.homedir(), sessionId: "s" });
  assert.deepEqual(res.injected, []);
  fs.rmSync(ws, { recursive: true, force: true });
});

check("injectBivyTools CREATES Codex's TOML config (mcp_servers.bivy) and restore deletes it", () => {
  const home = tmp();
  const file = path.join(home, ".codex", "config.toml");
  const res = injectBivyToolsForSession("codex", { workspace: home, home, sessionId: "sess-c", endpoint: "http://127.0.0.1:4317" });
  assert.deepEqual(res.injected, [file]);
  const toml = fs.readFileSync(file, "utf8");
  assert.match(toml, /\[mcp_servers\.bivy\]/);
  assert.match(toml, /command = "bivy"/);
  assert.match(toml, /args = \["mcp-serve"\]/);
  assert.match(toml, /BIVY_SESSION_ID = "sess-c"/);
  assert.match(toml, /BIVY_MCP_ENDPOINT = "http:\/\/127\.0\.0\.1:4317"/);

  res.restore();
  assert.equal(fs.existsSync(file), false, "restore must delete a created TOML");
  fs.rmSync(home, { recursive: true, force: true });
});

check("injectBivyTools APPENDS to an existing Codex TOML and restores exact bytes", () => {
  const home = tmp();
  const dir = path.join(home, ".codex");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "config.toml");
  const original = `model = "gpt-5"\n\n[mcp_servers.fs]\ncommand = "mcp-fs"\nargs = []\n`;
  fs.writeFileSync(file, original);

  const res = injectBivyToolsForSession("codex", { workspace: home, home, sessionId: "s" });
  assert.deepEqual(res.injected, [file]);
  const toml = fs.readFileSync(file, "utf8");
  assert.match(toml, /\[mcp_servers\.fs\]/, "existing servers preserved");
  assert.match(toml, /\[mcp_servers\.bivy\]/);

  res.restore();
  assert.equal(fs.readFileSync(file, "utf8"), original, "restore reproduces exact original bytes");
  fs.rmSync(home, { recursive: true, force: true });
});

check("injectBivyTools is idempotent on a Codex TOML that already declares bivy", () => {
  const home = tmp();
  const dir = path.join(home, ".codex");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "config.toml");
  fs.writeFileSync(file, `[mcp_servers.bivy]\ncommand = "bivy"\nargs = ["mcp-serve"]\n`);
  const res = injectBivyToolsForSession("codex", { workspace: home, home, sessionId: "s" });
  assert.deepEqual(res.injected, []);
  fs.rmSync(home, { recursive: true, force: true });
});

// --- OpenCode native `mcp` shape (rejects mcpServers) ------------------------

check("injectBivyTools CREATES opencode.json with mcp (not mcpServers) and restore deletes it", () => {
  const ws = tmp();
  const file = path.join(ws, "opencode.json");
  assert.equal(fs.existsSync(file), false);

  const res = injectBivyToolsForSession("opencode", {
    workspace: ws,
    home: os.homedir(),
    sessionId: "sess-oc",
    endpoint: "http://127.0.0.1:4318",
  });
  assert.deepEqual(res.injected, [file]);
  const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(cfg.mcpServers, undefined, "must not write the Cursor-style key OpenCode rejects");
  assert.equal(cfg.mcp.bivy.type, "local");
  assert.deepEqual(cfg.mcp.bivy.command, ["bivy", "mcp-serve"]);
  assert.equal(cfg.mcp.bivy.environment.BIVY_SESSION_ID, "sess-oc");
  assert.equal(cfg.mcp.bivy.environment.BIVY_MCP_ENDPOINT, "http://127.0.0.1:4318");

  res.restore();
  assert.equal(fs.existsSync(file), false, "restore must delete a file it created");
  fs.rmSync(ws, { recursive: true, force: true });
});

check("injectBivyTools ADDS to an existing OpenCode mcp map and restores exact bytes", () => {
  const ws = tmp();
  const file = path.join(ws, "opencode.json");
  const original =
    JSON.stringify({ mcp: { fs: { type: "local", command: ["mcp-fs", "--root", "/w"] } }, model: "openai/gpt-5" }, null, 2) + "\n";
  fs.writeFileSync(file, original);

  const res = injectBivyToolsForSession("opencode", { workspace: ws, home: os.homedir(), sessionId: "s" });
  assert.deepEqual(res.injected, [file]);
  const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(cfg.mcp.fs.command, ["mcp-fs", "--root", "/w"], "existing servers preserved");
  assert.equal(cfg.model, "openai/gpt-5", "other top-level keys preserved");
  assert.equal(cfg.mcp.bivy.type, "local");
  assert.deepEqual(cfg.mcp.bivy.command, ["bivy", "mcp-serve"]);

  res.restore();
  assert.equal(fs.readFileSync(file, "utf8"), original, "restore reproduces the original bytes exactly");
  fs.rmSync(ws, { recursive: true, force: true });
});

check("injectBivyTools is idempotent on OpenCode when bivy already present", () => {
  const ws = tmp();
  const file = path.join(ws, "opencode.json");
  fs.writeFileSync(file, JSON.stringify({ mcp: { bivy: { type: "local", command: ["bivy", "mcp-serve"] } } }));
  const res = injectBivyToolsForSession("opencode", { workspace: ws, home: os.homedir(), sessionId: "s" });
  assert.deepEqual(res.injected, []);
  fs.rmSync(ws, { recursive: true, force: true });
});

check("injectJsonMcpConfig routes OpenCode local servers via command argv array", () => {
  const dir = tmp();
  const file = path.join(dir, "opencode.json");
  const original =
    JSON.stringify({ mcp: { fs: { type: "local", command: ["mcp-fs", "--root", "/w"], environment: { X: "1" } } } }, null, 2) + "\n";
  fs.writeFileSync(file, original);

  const r = injectJsonMcpConfig(file, launcher);
  assert.equal(r.injected, true);
  const rewritten = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(rewritten.mcp.fs.command[0], "bivy");
  assert.ok(rewritten.mcp.fs.command.includes("--bivy-mcp"));
  assert.deepEqual(rewritten.mcp.fs.environment, { X: "1" });
  assert.equal(rewritten.mcpServers, undefined);

  r.restore();
  assert.equal(fs.readFileSync(file, "utf8"), original);
  fs.rmSync(dir, { recursive: true, force: true });
});

if (failures > 0) {
  console.error(`\n${failures} mcp-inject test(s) failed`);
  process.exit(1);
}
console.log("\nall mcp-inject tests passed");
