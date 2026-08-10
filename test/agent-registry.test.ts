// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import test from "node:test";
import { AgentRegistry, type AgentRegistryEntry } from "../src/runtime/agent-registry.js";
import { agentInstallSpec, canonicalAgentId, listRegisteredAgents } from "../src/runtime/index.js";

type Entry = AgentRegistryEntry<{ id: string }, void, string, string>;
const entry = (id: string, sourceLabel: string, aliases: string[] = []): Entry => ({
  id,
  aliases,
  visible: true,
  sourceLabel,
  describe: () => ({ id }),
  create: () => id,
  install: () => id,
});

test("one registry applies the same precedence and alias rules to every contribution", () => {
  const registry = new AgentRegistry<{ id: string }, void, string, string>();
  assert.equal(registry.register(entry("builtin", "a built-in runtime", ["legacy"])), true);
  assert.equal(registry.register(entry("builtin", "plugin override")), false);
  assert.equal(registry.register(entry("legacy", "plugin alias override")), false);
  assert.equal(registry.register(entry("external", "plugin external", ["legacy"])), true);

  assert.equal(registry.get("legacy")?.id, "builtin");
  assert.equal(registry.get("external")?.create?.(), "external");
  assert.deepEqual(registry.list().map((item) => item.id), ["builtin", "external"]);
  assert.deepEqual(registry.diagnostics(), [
    { id: "builtin", retainedSource: "a built-in runtime", rejectedSource: "plugin override" },
    { id: "legacy", retainedSource: "a built-in runtime", rejectedSource: "plugin alias override" },
    { id: "legacy", retainedSource: "a built-in runtime", rejectedSource: "plugin external" },
  ]);
});

test("built-ins expose explicit registry provenance, aliases, and install metadata", () => {
  const registered = listRegisteredAgents();
  assert.ok(registered.length >= 25);
  assert.ok(registered.every((agent) => agent.source?.kind === "builtin"));
  assert.equal(canonicalAgentId("open-code"), "opencode");
  assert.equal(canonicalAgentId("claude"), "claude-code-sdk");
  assert.match(agentInstallSpec("open-code", "/tmp/bivy-prefix")?.display ?? "", /opencode-ai/);
  assert.match(agentInstallSpec("open-claw", "/tmp/bivy-prefix")?.display ?? "", /openclaw/);
});
