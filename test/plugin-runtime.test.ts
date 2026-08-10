// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { installPlugin } from "../src/plugins/store.js";
import { listRuntimes, makeRuntime, pluginAgentConflictDiagnostics, type RuntimeEvent } from "../src/runtime/index.js";

const acpFixture = path.resolve(import.meta.dirname, "fixtures", "acp-agent.mjs");

async function waitFor(events: RuntimeEvent[], predicate: (event: RuntimeEvent) => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!events.some(predicate)) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for event; saw ${events.map((event) => event.type).join(", ")}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function manifest(id: string, adapter: string): string {
  return `
apiVersion: bivy.sh/v1alpha1
kind: Plugin
metadata:
  id: ${id}
  name: ${id}
  version: 0.1.0
contributes:
  agents:
    - id: ${id}
      name: ${id}
      description: Fixture plugin agent.
      authOwner: mixed
      adapter:
${adapter}
`;
}

test("installed process and ACP plugin agents join the authoritative runtime path", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-plugin-runtime-"));
  const oldDir = process.env.BIVY_PLUGIN_DIR;
  process.env.BIVY_PLUGIN_DIR = path.join(dir, "plugins");
  try {
    const processFile = path.join(dir, "process.yaml");
    fs.writeFileSync(processFile, manifest("fixture-process", `        kind: process
        command: node
        args: [--version]
        promptMode: argv
        resume:
          args: [--resume, "{id}"]
        model:
          flag: --model
          choices:
            - id: fixture-model
              provider: fixture
`));
    installPlugin(processFile, { dataDir: dir });

    const acpFile = path.join(dir, "acp.yaml");
    fs.writeFileSync(acpFile, manifest("fixture-acp", `        kind: acp
        command: node
        args: [${JSON.stringify(acpFixture)}]
`));
    installPlugin(acpFile, { dataDir: dir });

    const rows = listRuntimes();
    const processRow = rows.find((row) => row.id === "fixture-process");
    assert.equal(processRow?.status, "available");
    assert.equal(processRow?.supportTier, "experimental");
    assert.equal(processRow?.certification, "unverified");
    assert.equal(processRow?.executionMode, "pipe");
    assert.equal(processRow?.capabilities.resume, true);
    assert.equal(processRow?.capabilities.modelSelection, true);
    assert.deepEqual(processRow?.source, { kind: "plugin", pluginId: "fixture-process", pluginVersion: "0.1.0" });

    const acpRow = rows.find((row) => row.id === "fixture-acp");
    assert.equal(acpRow?.executionMode, "protocol");
    assert.equal(acpRow?.capabilities.toolInterception, true);
    assert.equal(acpRow?.capabilities.resume, true);
    assert.deepEqual(acpRow?.source, { kind: "plugin", pluginId: "fixture-acp", pluginVersion: "0.1.0" });

    const runtime = makeRuntime({
      runtime: "fixture-process",
      credsDir: path.join(dir, "credentials"),
      piDir: path.join(dir, "pi"),
      sessionsDir: path.join(dir, "sessions"),
    });
    assert.equal(runtime.id, "fixture-process");
    assert.equal(runtime.capabilities.resume, true);
    assert.equal(runtime.capabilities.modelSelection, true);

    const acpRuntime = makeRuntime({
      runtime: "fixture-acp",
      credsDir: path.join(dir, "credentials"),
      piDir: path.join(dir, "pi"),
      sessionsDir: path.join(dir, "sessions"),
    });
    assert.equal(acpRuntime.id, "fixture-acp");
    assert.equal(acpRuntime.capabilities.toolInterception, true);
    const decisions: string[] = [];
    const { session } = await acpRuntime.createSession({
      workspace: dir,
      toolInterceptor: async (ctx) => { decisions.push(ctx.toolName); return undefined; },
    });
    const events: RuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));
    await session.prompt("hello from plugin");
    await waitFor(events, (event) => event.type === "agent_end");
    assert.equal(decisions.length, 1);
    assert.equal(events.some((event) => event.type === "tool_call"), true);
    session.dispose();
  } finally {
    if (oldDir === undefined) delete process.env.BIVY_PLUGIN_DIR;
    else process.env.BIVY_PLUGIN_DIR = oldDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("plugin agents cannot replace built-in or config-defined runtime ids", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-plugin-conflict-"));
  const oldPluginDir = process.env.BIVY_PLUGIN_DIR;
  const oldCustom = process.env.BIVY_CUSTOM_AGENTS;
  process.env.BIVY_PLUGIN_DIR = path.join(dir, "plugins");
  process.env.BIVY_CUSTOM_AGENTS = JSON.stringify([{ id: "company-agent", extends: "aider", command: "node", label: "Config wins" }]);
  try {
    const builtin = path.join(dir, "builtin.yaml");
    fs.writeFileSync(builtin, manifest("pi", `        kind: process
        command: node
`));
    installPlugin(builtin, { dataDir: dir });
    const config = path.join(dir, "config.yaml");
    fs.writeFileSync(config, manifest("company-plugin", `        kind: process
        command: node
`)
      .replace("    - id: company-plugin", "    - id: company-agent")
      .replace("      name: company-plugin", "      name: Plugin loses"));
    installPlugin(config, { dataDir: dir });

    const rows = listRuntimes();
    assert.equal(rows.filter((row) => row.id === "pi").length, 1);
    assert.equal(rows.find((row) => row.id === "company-agent")?.displayName, "Config wins");
    assert.match(pluginAgentConflictDiagnostics().join("\n"), /agent id pi conflicts with a built-in runtime/);
    assert.match(pluginAgentConflictDiagnostics().join("\n"), /agent id company-agent conflicts with node configuration/);
    assert.deepEqual(rows.find((row) => row.id === "company-agent")?.source, { kind: "config" });
  } finally {
    if (oldPluginDir === undefined) delete process.env.BIVY_PLUGIN_DIR;
    else process.env.BIVY_PLUGIN_DIR = oldPluginDir;
    if (oldCustom === undefined) delete process.env.BIVY_CUSTOM_AGENTS;
    else process.env.BIVY_CUSTOM_AGENTS = oldCustom;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
