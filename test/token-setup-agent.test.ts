// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

// Exercise the actual noninteractive setup branch without enrolling a real
// machine or installing a background service on the test runner.
const source = fs.readFileSync(new URL("../bin/bivy.mjs", import.meta.url), "utf8");
const setup = source.slice(source.indexOf("async function cmdTokenSetup()"), source.indexOf("async function cmdSetup("));
const choices = [
  { runtimeId: "claude-code-sdk", command: "claude" },
  { runtimeId: "codex-approvals", command: "codex" },
  { runtimeId: "pi", command: "pi" },
];
async function selected(installed: string[], authed: string[], saved?: string) {
  const config = { workspace: "/work/project", port: 4317, env: saved ? { BIVY_RUNTIME: saved } : {} };
  const messages: string[] = [];
  const context = {
    ensureDeps: async () => true,
    loadConfig: () => config,
    repoRoot: "/bivy", nodeBin: "node", relaySetupEntry: "/relay.js",
    findAvailablePort: async () => 4317, nodeBindHost: () => "localhost",
    process: { env: {} },
    SETUP_AGENT_CHOICES: choices,
    commandExists: (command: string) => installed.includes(command),
    nativeAgentAuthDetected: (choice: { command: string }) => authed.includes(choice.command),
    saveConfig: () => {},
    nodeScriptArgs: (entry: string) => [entry], startEnv: () => ({}),
    run: async () => 0, installService: async () => true,
    c: { dim: String, bold: String, green: String },
    console: { log: (message: string) => messages.push(message) },
  };
  await vm.runInNewContext(`${setup}\ncmdTokenSetup()`, context);
  assert(messages.some((message) => message.includes("Return to the Bivy page")));
  return (config.env as { BIVY_RUNTIME?: string }).BIVY_RUNTIME;
}
assert.equal(await selected(["claude", "codex"], ["codex"]), "codex-approvals", "prefer an existing login over an unauthenticated installed agent");
assert.equal(await selected(["claude"], []), "claude-code-sdk", "reuse the installed agent even if login is still needed");
assert.equal(await selected([], []), "pi", "retain the bundled fallback when no external CLI is installed");
assert.equal(await selected(["claude"], ["claude"], "custom-agent"), "custom-agent", "never overwrite an explicit custom agent");
console.log("token-setup-agent: passed");
