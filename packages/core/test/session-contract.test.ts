// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { resolveSessionContract, type SessionContractInput } from "../src/session-contract.js";
import { normalizeSessionContract } from "../src/store-normalize.js";

const NOW = "2026-08-13T12:00:00.000Z";

const fullyGuaranteed = (over: Partial<SessionContractInput> = {}): SessionContractInput => ({
  now: NOW,
  preview: false,
  agentId: "claude-code",
  agentDisplayName: "Claude Code",
  detectedVersion: "0.3.220",
  versionSource: "reported",
  supportTier: "supported",
  certification: "release-tested",
  executionMode: "protocol",
  provider: "anthropic",
  modelId: "claude-opus-5",
  modelConfigured: true,
  authKind: "oauth",
  authOrigin: "bivy",
  resumeAdvertised: true,
  resumeRefIsPath: false,
  toolInterceptionEnforced: true,
  approvalMode: "risky",
  sandboxTier: "workspace-write",
  runtimeEnforcement: "native-sandbox",
  ...over,
});

describe("resolveSessionContract", () => {
  it("reports every area guaranteed and no degraded reasons when every fact is fully observed", () => {
    const contract = resolveSessionContract(fullyGuaranteed());
    expect(contract.schemaVersion).toBe("session-contract.v1");
    expect(contract.executionMode).toEqual({ effective: "protocol", structuredStreaming: true, state: "guaranteed" });
    expect(contract.auth).toEqual({ kind: "oauth", origin: "bivy", state: "guaranteed" });
    expect(contract.resume).toEqual({ advertised: true, refIsPath: false, state: "guaranteed" });
    expect(contract.toolInterception.state).toBe("guaranteed");
    expect(contract.sandbox).toEqual({ tier: "workspace-write", runtimeEnforcement: "native-sandbox", evidenceClass: "enforced", state: "guaranteed" });
    expect(contract.degradedReasons).toEqual([]);
    expect(contract.requiresAcknowledgement).toBe(false);
  });

  it("is a pure, deterministic function of its input", () => {
    const input = fullyGuaranteed();
    expect(resolveSessionContract(input)).toEqual(resolveSessionContract({ ...input }));
  });

  it("never invents an agent version — absence yields versionSource unknown plus a reason", () => {
    const contract = resolveSessionContract(fullyGuaranteed({ detectedVersion: undefined, versionSource: undefined }));
    expect(contract.agent.versionSource).toBe("unknown");
    expect(contract.agent.detectedVersion).toBeUndefined();
    expect(contract.degradedReasons).toContainEqual({ area: "agent", code: "agent_version_unknown", message: expect.any(String) });
  });

  it("degrades execution mode to unstructured for a plain pipe, and unavailable when unresolved", () => {
    const pipe = resolveSessionContract(fullyGuaranteed({ executionMode: "pipe" }));
    expect(pipe.executionMode).toEqual({ effective: "pipe", structuredStreaming: false, state: "degraded" });
    expect(pipe.degradedReasons.map((r) => r.code)).toContain("execution_mode_unstructured");

    const unknown = resolveSessionContract(fullyGuaranteed({ executionMode: undefined }));
    expect(unknown.executionMode.state).toBe("unavailable");
    expect(unknown.degradedReasons.map((r) => r.code)).toContain("execution_mode_unknown");
  });

  it("reports auth as unavailable, distinctly, for unknown vs unconfigured", () => {
    const unknown = resolveSessionContract(fullyGuaranteed({ authKind: undefined }));
    expect(unknown.auth.state).toBe("unavailable");
    expect(unknown.degradedReasons.map((r) => r.code)).toContain("auth_unknown");

    const none = resolveSessionContract(fullyGuaranteed({ authKind: "none" }));
    expect(none.auth.state).toBe("unavailable");
    expect(none.degradedReasons.map((r) => r.code)).toContain("auth_unconfigured");
  });

  it("reports resume unavailable (not degraded) when unsupported — no partial-credit state", () => {
    const contract = resolveSessionContract(fullyGuaranteed({ resumeAdvertised: false, resumeRefIsPath: undefined }));
    expect(contract.resume).toEqual({ advertised: false, refIsPath: false, state: "unavailable" });
    expect(contract.degradedReasons.map((r) => r.code)).toContain("resume_unsupported");
  });

  it("distinguishes MCP-only tool interception (degraded) from none at all (unavailable)", () => {
    const mcpOnly = resolveSessionContract(fullyGuaranteed({ toolInterceptionEnforced: false, mcpToolApprovalsOnly: true }));
    expect(mcpOnly.toolInterception).toMatchObject({ enforced: false, mcpOnly: true, state: "degraded" });
    expect(mcpOnly.degradedReasons.map((r) => r.code)).toContain("tool_interception_mcp_only");

    const none = resolveSessionContract(fullyGuaranteed({ toolInterceptionEnforced: false, mcpToolApprovalsOnly: false }));
    expect(none.toolInterception).toMatchObject({ enforced: false, mcpOnly: false, state: "unavailable" });
    expect(none.degradedReasons.map((r) => r.code)).toContain("tool_interception_unavailable");
  });

  it("maps runtime enforcement to the same enforced/observed/unavailable evidence classes as Receipt v1", () => {
    const observed = resolveSessionContract(fullyGuaranteed({ runtimeEnforcement: "tool-controls" }));
    expect(observed.sandbox).toMatchObject({ evidenceClass: "observed", state: "degraded" });

    const unavailable = resolveSessionContract(fullyGuaranteed({ runtimeEnforcement: "user-permissions" }));
    expect(unavailable.sandbox).toMatchObject({ evidenceClass: "unavailable", state: "unavailable" });

    const none = resolveSessionContract(fullyGuaranteed({ runtimeEnforcement: undefined }));
    expect(none.sandbox).toMatchObject({ runtimeEnforcement: "none", evidenceClass: "unavailable", state: "unavailable" });
  });

  describe("requiresAcknowledgement gate", () => {
    it("requires acknowledgement for a release-tested profile with a degraded protection area", () => {
      const contract = resolveSessionContract(fullyGuaranteed({ runtimeEnforcement: "user-permissions" }));
      expect(contract.requiresAcknowledgement).toBe(true);
    });

    it("does not require acknowledgement for the same degradation on an adapter-tested wrapper — the gap is disclosed", () => {
      const contract = resolveSessionContract(fullyGuaranteed({ certification: "adapter-tested", runtimeEnforcement: "user-permissions" }));
      expect(contract.requiresAcknowledgement).toBe(false);
    });

    it("does not require acknowledgement for a supported profile whose only degradation is informational (agent version)", () => {
      const contract = resolveSessionContract(fullyGuaranteed({ detectedVersion: undefined, versionSource: undefined }));
      expect(contract.degradedReasons.map((r) => r.area)).toEqual(["agent"]);
      expect(contract.requiresAcknowledgement).toBe(false);
    });

    it("clears once an acknowledgedAt is supplied, and carries it through", () => {
      const contract = resolveSessionContract(fullyGuaranteed({ runtimeEnforcement: "user-permissions", acknowledgedAt: NOW }));
      expect(contract.requiresAcknowledgement).toBe(false);
      expect(contract.acknowledgedAt).toBe(NOW);
    });
  });

  it("marks preview contracts as preview: true, independent of fact completeness", () => {
    const contract = resolveSessionContract(fullyGuaranteed({ preview: true, detectedVersion: undefined, versionSource: undefined }));
    expect(contract.preview).toBe(true);
  });
});

describe("normalizeSessionContract (wire hydration)", () => {
  it("round-trips a well-formed contract unchanged", () => {
    const contract = resolveSessionContract(fullyGuaranteed());
    expect(normalizeSessionContract(contract)).toEqual(contract);
  });

  it("drops undefined/null/non-object payloads", () => {
    expect(normalizeSessionContract(undefined)).toBeUndefined();
    expect(normalizeSessionContract(null)).toBeUndefined();
    expect(normalizeSessionContract("session-contract.v1")).toBeUndefined();
  });

  it("drops a contract from a node on a different schema version rather than guessing its shape", () => {
    const contract = resolveSessionContract(fullyGuaranteed());
    expect(normalizeSessionContract({ ...contract, schemaVersion: "session-contract.v0" })).toBeUndefined();
  });

  it("drops a malformed contract missing a required area instead of partially reconstructing it", () => {
    const contract = resolveSessionContract(fullyGuaranteed()) as unknown as Record<string, unknown>;
    const { sandbox: _sandbox, ...withoutSandbox } = contract;
    expect(normalizeSessionContract(withoutSandbox)).toBeUndefined();
  });

  it("drops a contract whose area state is not one of the known guarantee states", () => {
    const contract = resolveSessionContract(fullyGuaranteed());
    expect(normalizeSessionContract({ ...contract, auth: { ...contract.auth, state: "totally-fine" } })).toBeUndefined();
  });
});
