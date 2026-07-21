import assert from "node:assert/strict";
import { routeThroughProxy, parseProxiedArgs, isProxied, PROXY_MARKER, type McpConfig } from "../src/harness/mcp-config.js";

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

const launcher = { command: "bivy", argsPrefix: ["mcp-proxy"] };

check("routes a stdio server through the proxy", () => {
  const cfg: McpConfig = { mcpServers: { fs: { command: "mcp-fs", args: ["--root", "/w"], env: { X: "1" } } } };
  const out = routeThroughProxy(cfg, launcher);
  assert.deepEqual(out.rewritten, ["fs"]);
  assert.deepEqual(out.skipped, []);
  const fs = out.config.mcpServers!.fs;
  assert.equal(fs.command, "bivy");
  assert.deepEqual(fs.args, ["mcp-proxy", PROXY_MARKER, "--server", "fs", "--", "mcp-fs", "--root", "/w"]);
  assert.deepEqual(fs.env, { X: "1" }, "env is preserved");
});

check("does not mutate the input config", () => {
  const cfg: McpConfig = { mcpServers: { fs: { command: "mcp-fs", args: ["--root", "/w"] } } };
  routeThroughProxy(cfg, launcher);
  assert.equal(cfg.mcpServers!.fs.command, "mcp-fs", "original command untouched");
});

check("leaves remote (url) servers untouched", () => {
  const cfg: McpConfig = { mcpServers: { remote: { url: "https://mcp.example/sse", type: "sse" } } };
  const out = routeThroughProxy(cfg, launcher);
  assert.deepEqual(out.rewritten, []);
  assert.deepEqual(out.skipped, ["remote"]);
  assert.deepEqual(out.config.mcpServers!.remote, { url: "https://mcp.example/sse", type: "sse" });
});

check("is idempotent (already-proxied server is skipped)", () => {
  const cfg: McpConfig = { mcpServers: { fs: { command: "mcp-fs", args: ["--root", "/w"] } } };
  const once = routeThroughProxy(cfg, launcher);
  const twice = routeThroughProxy(once.config, launcher);
  assert.deepEqual(twice.rewritten, [], "second pass rewrites nothing");
  assert.deepEqual(twice.skipped, ["fs"]);
  assert.deepEqual(twice.config.mcpServers!.fs.args, once.config.mcpServers!.fs.args, "args unchanged on second pass");
});

check("isProxied detects routed servers", () => {
  const cfg: McpConfig = { mcpServers: { fs: { command: "mcp-fs", args: [] } } };
  const out = routeThroughProxy(cfg, launcher);
  assert.equal(isProxied(out.config.mcpServers!.fs, launcher), true);
  assert.equal(isProxied({ command: "mcp-fs", args: [] }, launcher), false);
});

check("handles empty / missing mcpServers", () => {
  assert.deepEqual(routeThroughProxy({}, launcher).config.mcpServers, {});
  assert.deepEqual(routeThroughProxy({ mcpServers: {} }, launcher).rewritten, []);
});

check("parseProxiedArgs recovers server name + original command", () => {
  const cfg: McpConfig = { mcpServers: { fs: { command: "mcp-fs", args: ["--root", "/w"] } } };
  const out = routeThroughProxy(cfg, launcher);
  const parsed = parseProxiedArgs(out.config.mcpServers!.fs.args!);
  assert.ok(parsed);
  assert.equal(parsed!.server, "fs");
  assert.equal(parsed!.command, "mcp-fs");
  assert.deepEqual(parsed!.args, ["--root", "/w"]);
});

check("parseProxiedArgs returns null without a -- tail", () => {
  assert.equal(parseProxiedArgs(["mcp-proxy", "--server", "fs"]), null);
});

if (failures > 0) {
  console.error(`\n${failures} mcp-config test(s) failed`);
  process.exit(1);
}
console.log("\nall mcp-config tests passed");
