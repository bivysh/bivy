// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createServer } from "node:http";
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
    assert.deepEqual(processRow?.source, {
      kind: "package", packageId: "fixture-process", packageVersion: "0.1.0", location: "installed", verified: false,
    });

    const acpRow = rows.find((row) => row.id === "fixture-acp");
    assert.equal(acpRow?.executionMode, "protocol");
    assert.equal(acpRow?.capabilities.toolInterception, true);
    assert.equal(acpRow?.capabilities.resume, true);
    assert.deepEqual(acpRow?.source, {
      kind: "package", packageId: "fixture-acp", packageVersion: "0.1.0", location: "installed", verified: false,
    });

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

test("plugin agents cannot replace retained package or config-defined integration ids", () => {
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
    const alias = path.join(dir, "alias.yaml");
    fs.writeFileSync(alias, manifest("claude", `        kind: process
        command: node
`));
    installPlugin(alias, { dataDir: dir });

    const rows = listRuntimes();
    assert.equal(rows.filter((row) => row.id === "pi").length, 1);
    assert.equal(rows.find((row) => row.id === "company-agent")?.displayName, "Config wins");
    assert.match(pluginAgentConflictDiagnostics().join("\n"), /agent id pi conflicts with bivy-agent-integrations integration package/);
    assert.match(pluginAgentConflictDiagnostics().join("\n"), /agent id company-agent conflicts with node configuration/);
    assert.match(pluginAgentConflictDiagnostics().join("\n"), /agent id claude conflicts with bivy-agent-integrations integration package/);
    assert.deepEqual(rows.find((row) => row.id === "company-agent")?.source, { kind: "config" });
  } finally {
    if (oldPluginDir === undefined) delete process.env.BIVY_PLUGIN_DIR;
    else process.env.BIVY_PLUGIN_DIR = oldPluginDir;
    if (oldCustom === undefined) delete process.env.BIVY_CUSTOM_AGENTS;
    else process.env.BIVY_CUSTOM_AGENTS = oldCustom;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A Pi package with an extension (model provider + tool) and a skill. */
function writePiPackage(dir: string): void {
  fs.mkdirSync(path.join(dir, "skills", "fixture-guide"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
    name: "fixture-pi-package", type: "module", keywords: ["pi-package"], pi: { extensions: ["./extension.js"], skills: ["./skills"] },
  }));
  fs.writeFileSync(path.join(dir, "extension.js"), `
export default function (pi) {
  pi.registerProvider("fixture", {
    baseUrl: process.env.FIXTURE_PI_ENDPOINT, apiKey: "test-only", api: "openai-completions",
    models: [{ id: "model", name: "Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 }],
  });
  pi.registerTool({ name: "fixture_tool", label: "Fixture", description: "Fixture tool from the plugin's package.", parameters: { type: "object", properties: {} },
    async execute() { return { content: [{ type: "text", text: "ok" }], details: {} }; } });
}
`);
  fs.writeFileSync(path.join(dir, "skills", "fixture-guide", "SKILL.md"), "---\nname: fixture-guide\ndescription: Fixture guidance. Use for fixtures.\n---\n\nFIXTURE GUIDE INSTRUCTIONS\n");
}

test("an installed Pi plugin agent is Pi with the plugin's packages and preloaded skills", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-plugin-pi-"));
  const saved = { plugin: process.env.BIVY_PLUGIN_DIR, endpoint: process.env.FIXTURE_PI_ENDPOINT, command: process.env.BIVY_PI_COMMAND };
  const bodies: Array<{ messages: Array<{ role: string; content: unknown }>; tools?: Array<{ function: { name: string } }> }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = (delta: unknown, finish: string | null) => `data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", created: 1, model: "model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    response.end(chunk({ role: "assistant", content: "Done." }, null) + chunk({}, "stop") + "data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  process.env.BIVY_PLUGIN_DIR = path.join(dir, "plugins");
  process.env.FIXTURE_PI_ENDPOINT = `http://127.0.0.1:${address.port}/v1`;
  process.env.BIVY_PI_COMMAND = process.execPath; // availability check only; the TUI is not launched
  try {
    const source = path.join(dir, "source");
    writePiPackage(path.join(source, "pkg"));
    fs.writeFileSync(path.join(source, "bivy.plugin.yaml"), manifest("fixture-pi", `        kind: pi
        packages: [./pkg]
        skills: [fixture-guide]
`));
    const installed = installPlugin(source, { dataDir: dir });
    const adapter = installed.manifest.contributes.agents[0]?.adapter;
    assert.deepEqual(adapter?.kind === "pi" && adapter.packages, [path.join(source, "pkg")], "relative package paths are stored resolved");

    const row = listRuntimes().find((candidate) => candidate.id === "fixture-pi");
    assert.equal(row?.executionMode, "protocol");
    assert.equal(row?.supportTier, "experimental");
    assert.equal(row?.capabilities.toolInterception, true);

    const runtime = makeRuntime({ runtime: "fixture-pi", credsDir: path.join(dir, "credentials"), piDir: path.join(dir, "pi"), sessionsDir: path.join(dir, "sessions") });
    assert.equal(runtime.id, "fixture-pi");
    const workspace = fs.mkdtempSync(path.join(dir, "workspace-"));
    const { session } = await runtime.createSession({ workspace });
    try {
      assert.ok(session.getCommands?.().some((command) => command.name === "/skill:fixture-guide"));
      await session.setModel?.("fixture", "model");
      await session.prompt("hello");
      const system = JSON.stringify(bodies[0]?.messages.filter((message) => message.role === "system" || message.role === "developer"));
      assert.match(system, /FIXTURE GUIDE INSTRUCTIONS/, "the preloaded skill is in the system prompt");
      assert.doesNotMatch(system, /name: fixture-guide/, "without its frontmatter");
      assert.doesNotMatch(system, /fixture-guide\/SKILL\.md/, "and not advertised again as an on-demand skill");
      assert.ok(bodies[0]?.tools?.some((tool) => tool.function.name === "fixture_tool"), "the package's extension is loaded");
      const tui = await session.interactiveTuiCommand?.();
      assert.deepEqual(tui?.args.slice(0, 4), ["-e", path.join(source, "pkg"), "--append-system-prompt", "FIXTURE GUIDE INSTRUCTIONS"]);
    } finally {
      session.dispose();
    }
  } finally {
    server.closeAllConnections();
    server.close();
    for (const [key, value] of [["BIVY_PLUGIN_DIR", saved.plugin], ["FIXTURE_PI_ENDPOINT", saved.endpoint], ["BIVY_PI_COMMAND", saved.command]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
