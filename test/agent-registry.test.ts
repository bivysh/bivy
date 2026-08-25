// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import test from "node:test";
import type { AgentIntegration, AgentIntegrationOrigin } from "../src/agents/definition.js";
import { AgentRegistry } from "../src/agents/registry.js";
import { agentInstallSpec, canonicalAgentId, invalidateCliProbeCache, listRegisteredAgents } from "../src/runtime/index.js";

type Entry = AgentIntegration<{ id: string }, void, string, string>;
const packageOrigin = (packageId: string, location: "distribution" | "installed" = "installed"): AgentIntegrationOrigin => ({
  kind: "package",
  packageId,
  packageVersion: "1.0.0",
  location,
  verified: location === "distribution",
});
const entry = (id: string, origin: AgentIntegrationOrigin, aliases: string[] = []): Entry => ({
  id,
  aliases,
  visible: true,
  origin,
  describe: () => ({ id }),
  create: () => id,
  install: () => id,
});

test("one registry applies the same precedence and alias rules to every integration", () => {
  const registry = new AgentRegistry<{ id: string }, void, string, string>();
  assert.equal(registry.register(entry("catalog-agent", packageOrigin("bivy-agents", "distribution"), ["legacy"])), true);
  assert.equal(registry.register(entry("catalog-agent", packageOrigin("override"))), false);
  assert.equal(registry.register(entry("legacy", packageOrigin("alias-override"))), false);
  assert.equal(registry.register(entry("external", packageOrigin("external"), ["legacy"])), true);

  assert.equal(registry.get("legacy")?.id, "catalog-agent");
  assert.equal(registry.get("external")?.create?.(), "external");
  assert.deepEqual(registry.list().map((item) => item.id), ["catalog-agent", "external"]);
  assert.deepEqual(registry.diagnostics().map(({ id, retainedSource, rejectedSource }) => ({ id, retainedSource, rejectedSource })), [
    { id: "catalog-agent", retainedSource: "bivy-agents integration package", rejectedSource: "plugin override" },
    { id: "legacy", retainedSource: "bivy-agents integration package", rejectedSource: "plugin alias-override" },
    { id: "legacy", retainedSource: "bivy-agents integration package", rejectedSource: "plugin external" },
  ]);
});

test("catalog profiles expose package provenance, aliases, and install metadata", () => {
  const registered = listRegisteredAgents();
  assert.ok(registered.length >= 25);
  assert.ok(registered.every((agent) => agent.source?.kind === "package"));
  assert.ok(registered.every((agent) => agent.source?.kind !== "package" || agent.source.packageId === "bivy-agent-integrations"));
  assert.ok(registered.every((agent) => agent.credentialRequirements));
  assert.deepEqual(registered.find((agent) => agent.id === "claude-code-sdk")?.credentialRequirements, {
    owner: "agent", strategy: "agent-login", providers: ["anthropic"],
  });
  assert.equal(canonicalAgentId("open-code"), "opencode");
  assert.equal(canonicalAgentId("claude"), "claude-code-sdk");
  assert.match(agentInstallSpec("open-code", "/tmp/bivy-prefix")?.display ?? "", /opencode-ai/);
  assert.match(agentInstallSpec("open-claw", "/tmp/bivy-prefix")?.display ?? "", /openclaw/);
});

test("rich integrations require the operator's upstream agent command", () => {
  const previousPi = process.env.BIVY_PI_COMMAND;
  const previousClaude = process.env.BIVY_CLAUDE_COMMAND;
  const previousCodex = process.env.BIVY_CODEX_BIN;
  try {
    process.env.BIVY_PI_COMMAND = "/definitely/missing/pi";
    process.env.BIVY_CLAUDE_COMMAND = "/definitely/missing/claude";
    process.env.BIVY_CODEX_BIN = "/definitely/missing/codex";
    invalidateCliProbeCache();
    const registered = listRegisteredAgents();
    assert.equal(registered.find((agent) => agent.id === "pi")?.status, "external");
    assert.equal(registered.find((agent) => agent.id === "claude-code-sdk")?.status, "external");
    assert.equal(registered.find((agent) => agent.id === "codex-approvals")?.status, "external");
    assert.match(agentInstallSpec("pi", "/tmp/bivy-prefix")?.display ?? "", /pi-coding-agent/);
    assert.match(agentInstallSpec("claude", "/tmp/bivy-prefix")?.display ?? "", /claude-code/);
    assert.match(agentInstallSpec("codex-approvals", "/tmp/bivy-prefix")?.display ?? "", /openai\/codex/);
  } finally {
    if (previousPi === undefined) delete process.env.BIVY_PI_COMMAND;
    else process.env.BIVY_PI_COMMAND = previousPi;
    if (previousClaude === undefined) delete process.env.BIVY_CLAUDE_COMMAND;
    else process.env.BIVY_CLAUDE_COMMAND = previousClaude;
    if (previousCodex === undefined) delete process.env.BIVY_CODEX_BIN;
    else process.env.BIVY_CODEX_BIN = previousCodex;
    invalidateCliProbeCache();
  }
});
