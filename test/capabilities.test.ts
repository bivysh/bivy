// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { normalizeCapabilities, type RawCapabilityInputs } from "../src/capabilities.js";

const BASE_OS = { platform: "linux", arch: "x64", release: "6.1.0", type: "Linux" };

function baseRaw(overrides: Partial<RawCapabilityInputs> = {}): RawCapabilityInputs {
  return {
    os: BASE_OS,
    agents: [
      { id: "claude-code-sdk", label: "Claude Code", kind: "maintained", installed: true, supportTier: "supported" },
      { id: "codex-approvals", label: "Codex", kind: "maintained", installed: false, supportTier: "supported" },
      { id: "my-custom-agent", label: "My Custom Agent", kind: "custom", installed: true },
    ],
    configuredProviderIds: ["anthropic"],
    localEndpoints: [{ id: "ollama", modelCount: 2 }, { id: "lmstudio", modelCount: 0 }],
    docker: { state: "available", detail: "Docker 27.3.1" },
    gpu: { state: "unknown" },
    plugins: [{ id: "my-plugin", name: "My Plugin", version: "1.0.0", valid: true, agentCount: 1 }],
    workspaceCount: 3,
    now: Date.UTC(2026, 0, 1),
    ...overrides,
  };
}

// --- splits agents into maintained vs custom, preserving installed/supportTier

{
  const snapshot = normalizeCapabilities(baseRaw());
  assert.deepEqual(snapshot.agents.maintained.map((a) => a.id), ["claude-code-sdk", "codex-approvals"]);
  assert.deepEqual(snapshot.agents.custom.map((a) => a.id), ["my-custom-agent"]);
  assert.deepEqual(snapshot.agents.maintained[0], {
    id: "claude-code-sdk", label: "Claude Code", kind: "maintained", installed: true, supportTier: "supported",
  });
  assert.equal(snapshot.agents.custom[0].supportTier, undefined);
}

// --- counts local endpoints and how many have models, without listing model details

{
  const snapshot = normalizeCapabilities(baseRaw());
  assert.deepEqual(snapshot.providers.localEndpoints, { count: 2, withModels: 1 });
}

// --- dedupes configured provider ids; only ids reach the shape (no key material)

{
  const snapshot = normalizeCapabilities(baseRaw({ configuredProviderIds: ["anthropic", "anthropic", "openai"] }));
  assert.deepEqual(snapshot.providers.configured, ["anthropic", "openai"]);
  for (const id of snapshot.providers.configured) assert.equal(typeof id, "string");
}

// --- an absent probe defaults to unknown instead of throwing

{
  const snapshot = normalizeCapabilities(baseRaw({ docker: undefined, gpu: undefined }));
  assert.deepEqual(snapshot.docker, { state: "unknown" });
  assert.deepEqual(snapshot.gpu, { state: "unknown" });
}

// --- an invalid probe state is rejected rather than passed through

{
  const snapshot = normalizeCapabilities(baseRaw({ docker: { state: "definitely-available" as never } }));
  assert.deepEqual(snapshot.docker, { state: "unknown" });
}

// --- agent/provider/plugin lists are bounded so an oversized source can't reach a client unbounded

{
  const manyAgents = Array.from({ length: 500 }, (_, i) => ({
    id: `agent-${i}`, label: `Agent ${i}`, kind: "maintained" as const, installed: true,
  }));
  const manyProviders = Array.from({ length: 500 }, (_, i) => `provider-${i}`);
  const manyPlugins = Array.from({ length: 500 }, (_, i) => ({ id: `plugin-${i}`, valid: true, agentCount: 1 }));
  const snapshot = normalizeCapabilities(baseRaw({ agents: manyAgents, configuredProviderIds: manyProviders, plugins: manyPlugins }));
  assert.ok(snapshot.agents.maintained.length <= 200);
  assert.ok(snapshot.providers.configured.length <= 100);
  assert.ok(snapshot.plugins.length <= 200);
}

// --- plugin entries are rebuilt field-by-field so unexpected extra fields never pass through

{
  const snapshot = normalizeCapabilities(baseRaw({
    plugins: [{ id: "p", name: "P", version: "1.0.0", valid: true, agentCount: 2, ...({ secretToken: "shh" } as never) }],
  }));
  assert.deepEqual(snapshot.plugins, [{ id: "p", name: "P", version: "1.0.0", valid: true, agentCount: 2 }]);
  assert.ok(!Object.hasOwn(snapshot.plugins[0], "secretToken"));
}

// --- negative/fractional counts clamp to a safe non-negative integer

{
  const snapshot = normalizeCapabilities(baseRaw({ workspaceCount: -5 }));
  assert.equal(snapshot.workspaces.count, 0);
  const snapshot2 = normalizeCapabilities(baseRaw({ plugins: [{ id: "p", valid: true, agentCount: -3 }] }));
  assert.equal(snapshot2.plugins[0].agentCount, 0);
}

// --- uses the injected clock deterministically

{
  const snapshot = normalizeCapabilities(baseRaw({ now: Date.UTC(2026, 0, 1) }));
  assert.equal(snapshot.generatedAt, "2026-01-01T00:00:00.000Z");
}

console.log("capabilities: normalization, redaction, and boundedness passed");
