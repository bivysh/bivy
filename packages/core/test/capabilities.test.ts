import { describe, expect, it } from "vitest";
import {
  describeCapabilityState,
  normalizeCapabilities,
  summarizeCapabilityStates,
  type RawCapabilityInputs,
} from "../src/capabilities.js";

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

describe("normalizeCapabilities", () => {
  it("splits agents into maintained vs custom and preserves installed/supportTier", () => {
    const snapshot = normalizeCapabilities(baseRaw());
    expect(snapshot.agents.maintained.map((a) => a.id)).toEqual(["claude-code-sdk", "codex-approvals"]);
    expect(snapshot.agents.custom.map((a) => a.id)).toEqual(["my-custom-agent"]);
    expect(snapshot.agents.maintained[0]).toEqual({
      id: "claude-code-sdk", label: "Claude Code", kind: "maintained", installed: true, supportTier: "supported",
    });
    expect(snapshot.agents.custom[0].supportTier).toBeUndefined();
  });

  it("counts local endpoints and how many have models configured, without listing model details", () => {
    const snapshot = normalizeCapabilities(baseRaw());
    expect(snapshot.providers.localEndpoints).toEqual({ count: 2, withModels: 1 });
  });

  it("dedupes configured provider ids and never carries key material (only ids reach the shape)", () => {
    const snapshot = normalizeCapabilities(baseRaw({ configuredProviderIds: ["anthropic", "anthropic", "openai"] }));
    expect(snapshot.providers.configured).toEqual(["anthropic", "openai"]);
    for (const id of snapshot.providers.configured) expect(typeof id).toBe("string");
  });

  it("defaults an absent probe to unknown instead of throwing", () => {
    const snapshot = normalizeCapabilities(baseRaw({ docker: undefined, gpu: undefined }));
    expect(snapshot.docker).toEqual({ state: "unknown" });
    expect(snapshot.gpu).toEqual({ state: "unknown" });
  });

  it("rejects a probe result with an invalid state rather than passing it through", () => {
    const snapshot = normalizeCapabilities(baseRaw({ docker: { state: "definitely-available" as never } }));
    expect(snapshot.docker).toEqual({ state: "unknown" });
  });

  it("bounds agent, provider, and plugin lists so an oversized source can't reach a client unbounded", () => {
    const manyAgents = Array.from({ length: 500 }, (_, i) => ({
      id: `agent-${i}`, label: `Agent ${i}`, kind: "maintained" as const, installed: true,
    }));
    const manyProviders = Array.from({ length: 500 }, (_, i) => `provider-${i}`);
    const manyPlugins = Array.from({ length: 500 }, (_, i) => ({
      id: `plugin-${i}`, valid: true, agentCount: 1,
    }));
    const snapshot = normalizeCapabilities(baseRaw({
      agents: manyAgents,
      configuredProviderIds: manyProviders,
      plugins: manyPlugins,
    }));
    expect(snapshot.agents.maintained.length).toBeLessThanOrEqual(200);
    expect(snapshot.providers.configured.length).toBeLessThanOrEqual(100);
    expect(snapshot.plugins.length).toBeLessThanOrEqual(200);
  });

  it("rebuilds plugin entries field-by-field so unexpected extra fields never pass through", () => {
    const snapshot = normalizeCapabilities(baseRaw({
      plugins: [{ id: "p", name: "P", version: "1.0.0", valid: true, agentCount: 2, ...({ secretToken: "shh" } as never) }],
    }));
    expect(snapshot.plugins).toEqual([{ id: "p", name: "P", version: "1.0.0", valid: true, agentCount: 2 }]);
    expect(snapshot.plugins[0]).not.toHaveProperty("secretToken");
  });

  it("clamps negative or fractional counts to a safe non-negative integer", () => {
    const snapshot = normalizeCapabilities(baseRaw({ workspaceCount: -5 }));
    expect(snapshot.workspaces.count).toBe(0);
    const snapshot2 = normalizeCapabilities(baseRaw({
      plugins: [{ id: "p", valid: true, agentCount: -3 }],
    }));
    expect(snapshot2.plugins[0].agentCount).toBe(0);
  });

  it("uses the injected clock deterministically", () => {
    const snapshot = normalizeCapabilities(baseRaw({ now: Date.UTC(2026, 0, 1) }));
    expect(snapshot.generatedAt).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("describeCapabilityState", () => {
  it("never conflates a capability probe with connection status", () => {
    expect(describeCapabilityState("available")).toBe("Available");
    expect(describeCapabilityState("unavailable")).toBe("Not available");
    expect(describeCapabilityState("unknown")).toBe("Unknown");
    for (const label of ["Available", "Not available", "Unknown"]) {
      expect(label).not.toMatch(/online|offline/i);
    }
  });
});

describe("summarizeCapabilityStates", () => {
  it("tallies each tri-state independently", () => {
    expect(summarizeCapabilityStates(["available", "available", "unknown", "unavailable"])).toEqual({
      available: 2, unavailable: 1, unknown: 1,
    });
  });

  it("returns all-zero counts for an empty list", () => {
    expect(summarizeCapabilityStates([])).toEqual({ available: 0, unavailable: 0, unknown: 0 });
  });
});
