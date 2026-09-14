// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { strict as assert } from "node:assert";
import test from "node:test";

import {
  computeSessionContract,
  resolveSessionContract,
  type SessionContractInput,
  type SessionContractRuntimeFacts,
} from "../src/session/session-contract.js";

const NOW = "2026-08-13T12:00:00.000Z";

const fullyGuaranteed = (over: Partial<SessionContractInput> = {}): SessionContractInput => ({
  now: NOW,
  preview: false,
  agentId: "claude-code",
  detectedVersion: "0.3.232",
  versionSource: "reported",
  supportTier: "supported",
  certification: "release-tested",
  executionMode: "protocol",
  authKind: "oauth",
  authOrigin: "bivy",
  resumeAdvertised: true,
  toolInterceptionEnforced: true,
  sandboxTier: "workspace-write",
  runtimeEnforcement: "native-sandbox",
  ...over,
});

test("resolveSessionContract: every area guaranteed, no degraded reasons, when fully observed", () => {
  const contract = resolveSessionContract(fullyGuaranteed());
  assert.equal(contract.executionMode.state, "guaranteed");
  assert.equal(contract.auth.state, "guaranteed");
  assert.equal(contract.resume.state, "guaranteed");
  assert.equal(contract.toolInterception.state, "guaranteed");
  assert.equal(contract.sandbox.state, "guaranteed");
  assert.deepEqual(contract.degradedReasons, []);
  assert.equal(contract.requiresAcknowledgement, false);
});

test("resolveSessionContract: requires acknowledgement for a release-tested profile whose sandbox is not natively enforced", () => {
  const contract = resolveSessionContract(fullyGuaranteed({ runtimeEnforcement: "user-permissions" }));
  assert.equal(contract.sandbox.state, "unavailable");
  assert.equal(contract.requiresAcknowledgement, true);
});

test("resolveSessionContract: an adapter-tested supported wrapper with the same degradation never requires acknowledgement", () => {
  const contract = resolveSessionContract(fullyGuaranteed({ certification: "adapter-tested", runtimeEnforcement: "user-permissions" }));
  assert.equal(contract.requiresAcknowledgement, false);
});

test("resolveSessionContract: an acknowledgedAt input clears the gate and is carried through", () => {
  const contract = resolveSessionContract(fullyGuaranteed({ runtimeEnforcement: "user-permissions", acknowledgedAt: NOW }));
  assert.equal(contract.requiresAcknowledgement, false);
  assert.equal(contract.acknowledgedAt, NOW);
});

test("resolveSessionContract: two concurrent resolutions for the same degraded profile agree — no shared mutable state to race on", async () => {
  const input = fullyGuaranteed({ runtimeEnforcement: "user-permissions" });
  const [a, b] = await Promise.all([
    Promise.resolve().then(() => resolveSessionContract(input)),
    Promise.resolve().then(() => resolveSessionContract(input)),
  ]);
  assert.deepEqual(a, b);
  assert.equal(a.requiresAcknowledgement, true);
  assert.equal(b.requiresAcknowledgement, true);
});

test("computeSessionContract: maps RuntimeInfo protectionLevel/authOwner/capabilities honestly", () => {
  const runtime: SessionContractRuntimeFacts = {
    id: "codex",
    displayName: "Codex",
    executionMode: "structured-pipe",
    supportTier: "supported",
    certification: "release-tested",
    testedVersion: "0.147.0",
    protectionLevel: "native-sandbox",
    authOwner: "bivy",
    capabilities: { resume: true, sessionRefIsPath: false, toolInterception: true },
  };
  const contract = computeSessionContract({ runtime, preview: false, sandbox: "workspace-write", approvalMode: "risky" }, NOW);
  assert.equal(contract.agent.detectedVersion, "0.147.0");
  assert.equal(contract.agent.versionSource, "tested-pin");
  assert.equal(contract.executionMode.effective, "structured-pipe");
  assert.equal(contract.executionMode.structuredStreaming, true);
  assert.equal(contract.auth.origin, "bivy");
  assert.equal(contract.auth.kind, "unknown", "credential kind is not invented from authOwner alone");
  assert.equal(contract.resume.advertised, true);
  assert.equal(contract.sandbox.runtimeEnforcement, "native-sandbox");
  assert.equal(contract.sandbox.evidenceClass, "enforced");
});

test("computeSessionContract: an agent with no native sandbox and no tool interception is honestly unavailable, not guessed guaranteed", () => {
  const runtime: SessionContractRuntimeFacts = {
    id: "aider",
    supportTier: "experimental",
    protectionLevel: "user-permissions",
    authOwner: "agent",
    capabilities: {},
  };
  const contract = computeSessionContract({ runtime, preview: true }, NOW);
  assert.equal(contract.preview, true);
  assert.equal(contract.sandbox.evidenceClass, "unavailable");
  assert.equal(contract.toolInterception.enforced, false);
  assert.equal(contract.resume.advertised, false);
  assert.equal(contract.requiresAcknowledgement, false, "experimental agents never require acknowledgement");
});

test("computeSessionContract: mixed authOwner reports auth origin unknown rather than guessing bivy or agent-native", () => {
  const runtime: SessionContractRuntimeFacts = { id: "acp", supportTier: "experimental", authOwner: "mixed" };
  const contract = computeSessionContract({ runtime, preview: true }, NOW);
  assert.equal(contract.auth.origin, "unknown");
});

// The following mirror the session.new / POST /api/session launch gate in
// src/server.ts exactly: compute a contract with no acknowledgedAt to decide
// whether to reject, and (only on retry) one with acknowledgedAt set.
test("launch gate: a release-tested-but-degraded agent is rejected without acknowledgement, and admitted once acknowledged", () => {
  const runtime: SessionContractRuntimeFacts = {
    id: "codex",
    supportTier: "supported",
    certification: "release-tested",
    protectionLevel: "user-permissions",
    capabilities: { resume: true, toolInterception: true },
  };
  const unacknowledged = computeSessionContract({ runtime, preview: false }, NOW);
  assert.equal(unacknowledged.requiresAcknowledgement, true, "the gate must reject this launch");

  const acknowledged = computeSessionContract({ runtime, preview: false, acknowledgedAt: NOW }, NOW);
  assert.equal(acknowledged.requiresAcknowledgement, false, "an explicit acknowledgement admits the launch");
  assert.equal(acknowledged.acknowledgedAt, NOW);
});

test("launch gate: two concurrent unacknowledged requests for the same degraded profile are BOTH rejected — no race admits one", async () => {
  const runtime: SessionContractRuntimeFacts = {
    id: "codex",
    supportTier: "supported",
    certification: "release-tested",
    protectionLevel: "user-permissions",
  };
  const [a, b] = await Promise.all([
    Promise.resolve().then(() => computeSessionContract({ runtime, preview: false }, NOW)),
    Promise.resolve().then(() => computeSessionContract({ runtime, preview: false }, NOW)),
  ]);
  assert.equal(a.requiresAcknowledgement, true);
  assert.equal(b.requiresAcknowledgement, true);
});

test("launch gate: a supported adapter-tested wrapper is never rejected, even fully unprotected", () => {
  const runtime: SessionContractRuntimeFacts = { id: "aider", supportTier: "supported", certification: "adapter-tested", protectionLevel: "user-permissions" };
  const contract = computeSessionContract({ runtime, preview: false }, NOW);
  assert.equal(contract.requiresAcknowledgement, false);
});
