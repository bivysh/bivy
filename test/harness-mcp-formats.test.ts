import assert from "node:assert/strict";
import { injectTomlMcp, injectYamlMcp } from "../src/harness/mcp-config-formats.js";

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

// ---- Codex TOML ----------------------------------------------------------
check("toml: reroutes command + args in an [mcp_servers.*] table", () => {
  const src = [
    "model = \"o3\"",
    "",
    "[mcp_servers.fs]",
    "command = \"mcp-fs\"",
    "args = [\"--root\", \"/w\"]",
    "",
    "[other]",
    "x = 1",
  ].join("\n");
  const out = injectTomlMcp(src, launcher);
  assert.deepEqual(out.rewritten, ["fs"]);
  assert.match(out.content, /command = "bivy"/);
  assert.match(out.content, /args = \["mcp-proxy", "--bivy-mcp", "--server", "fs", "--", "mcp-fs", "--root", "\/w"\]/);
  // Untouched sections stay intact.
  assert.match(out.content, /\[other\]\nx = 1/);
  assert.match(out.content, /model = "o3"/);
});

check("toml: inserts args when the server had none", () => {
  const src = "[mcp_servers.solo]\ncommand = \"solo-mcp\"\n";
  const out = injectTomlMcp(src, launcher);
  assert.deepEqual(out.rewritten, ["solo"]);
  assert.match(out.content, /command = "bivy"/);
  assert.match(out.content, /args = \["mcp-proxy", "--bivy-mcp", "--server", "solo", "--", "solo-mcp"\]/);
});

check("toml: idempotent (already-proxied command not rewritten)", () => {
  const once = injectTomlMcp("[mcp_servers.fs]\ncommand = \"mcp-fs\"\nargs = []\n", launcher);
  const twice = injectTomlMcp(once.content, launcher);
  assert.deepEqual(twice.rewritten, [], "second pass rewrites nothing");
});

check("toml: no mcp_servers table → no-op", () => {
  const src = "model = \"o3\"\n[sandbox]\nmode = \"workspace\"\n";
  assert.deepEqual(injectTomlMcp(src, launcher).rewritten, []);
});

// ---- Goose YAML ----------------------------------------------------------
check("yaml: reroutes cmd + inline args in an extension", () => {
  const src = [
    "extensions:",
    "  fetch:",
    "    enabled: true",
    "    type: stdio",
    "    cmd: uvx",
    "    args: [mcp-server-fetch, --verbose]",
    "  builtin:",
    "    type: builtin",
  ].join("\n");
  const out = injectYamlMcp(src, launcher);
  assert.deepEqual(out.rewritten, ["fetch"]);
  assert.match(out.content, /cmd: "bivy"/);
  assert.match(out.content, /args: \["mcp-proxy", "--bivy-mcp", "--server", "fetch", "--", "uvx", "mcp-server-fetch", "--verbose"\]/);
  // The builtin extension (no cmd) is left untouched.
  assert.match(out.content, /builtin:\n {4}type: builtin/);
});

check("yaml: inserts args when absent", () => {
  const src = "extensions:\n  solo:\n    type: stdio\n    cmd: solo-mcp\n";
  const out = injectYamlMcp(src, launcher);
  assert.deepEqual(out.rewritten, ["solo"]);
  assert.match(out.content, /cmd: "bivy"/);
  assert.match(out.content, /args: \["mcp-proxy", "--bivy-mcp", "--server", "solo", "--", "solo-mcp"\]/);
});

check("yaml: idempotent", () => {
  const once = injectYamlMcp("extensions:\n  fetch:\n    cmd: uvx\n    args: [x]\n", launcher);
  const twice = injectYamlMcp(once.content, launcher);
  assert.deepEqual(twice.rewritten, []);
});

check("yaml: block-sequence args are left untouched (safe no-op on cmd only)", () => {
  // We only reroute cmd; block args stay as-is (documented limitation).
  const src = "extensions:\n  fetch:\n    cmd: uvx\n    args:\n      - mcp-server-fetch\n";
  const out = injectYamlMcp(src, launcher);
  assert.deepEqual(out.rewritten, ["fetch"]);
  assert.match(out.content, /cmd: "bivy"/);
  // An inserted inline args line takes precedence; original block remains but is
  // overridden by the earlier key at parse time — acceptable and safe.
  assert.match(out.content, /args: \["mcp-proxy"/);
});

check("yaml: no extensions → no-op", () => {
  assert.deepEqual(injectYamlMcp("provider: openai\nmodel: gpt-4o\n", launcher).rewritten, []);
});

if (failures > 0) {
  console.error(`\n${failures} mcp-format test(s) failed`);
  process.exit(1);
}
console.log("\nall mcp-format tests passed");
