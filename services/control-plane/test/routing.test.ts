import assert from "node:assert/strict";
import { decideRoute, type RoutingNode, type RoutingPolicy } from "../src/routing.js";

const policy: RoutingPolicy = {
  preferredNodeLabel: "preferred",
  preferredRuntimes: ["codex"],
  allowedRuntimes: ["codex", "pi"],
  preferredModels: ["gpt-5"],
  allowedModels: ["gpt-5", "claude"],
  allowedProviders: ["openai", "anthropic"],
  repository: "bivysh/bivy",
  requiredSandboxPolicy: "workspace-write",
  requiredApprovalPolicy: "never",
};

function node(id: string, patch: Partial<RoutingNode> = {}): RoutingNode {
  return {
    id,
    label: id,
    online: true,
    persistent: true,
    os: "linux",
    capabilities: ["git"],
    runtimes: ["codex"],
    providers: [{ id: "openai", authenticated: true, quota: "available", models: ["gpt-5"] }],
    repositories: ["bivysh/bivy"],
    sandboxPolicies: ["workspace-write"],
    approvalPolicies: ["never"],
    ...patch,
  };
}

const selected = decideRoute({ policy, nodes: [node("z"), node("a")], queuedAt: 0, now: 0 });
assert.equal(selected.status, "selected");
assert.equal(selected.status === "selected" && selected.selected.nodeId, "a", "ties use stable node id order");
assert.deepEqual(
  decideRoute({ policy, nodes: [node("z"), node("a")], queuedAt: 0, now: 0 }),
  selected,
  "same input is deterministic",
);

const missingAgent = decideRoute({ policy: { ...policy, requiredRuntime: "claude-code" }, nodes: [node("a")], queuedAt: 0, now: 0 });
assert.equal(missingAgent.status, "needs_attention");
assert.ok(missingAgent.reasons.some((r) => r.code === "runtime_required"));

const quotaFallback = decideRoute({
  policy,
  nodes: [
    node("preferred", { providers: [{ id: "openai", authenticated: true, quota: "exhausted", models: ["gpt-5"] }] }),
    node("fallback", { providers: [{ id: "anthropic", authenticated: true, models: ["claude"] }] }),
  ],
  queuedAt: 0,
  now: 0,
});
assert.equal(quotaFallback.status, "selected");
assert.equal(quotaFallback.status === "selected" && quotaFallback.selected.nodeId, "fallback");

for (const [name, patch, code] of [
  ["auth loss", { providers: [{ id: "openai", authenticated: false, models: ["gpt-5"] }] }, "provider_auth_missing"],
  ["repo unreachable", { repositories: [] }, "repository_unreachable"],
] as const) {
  const result = decideRoute({ policy, nodes: [node("a", patch)], queuedAt: 0, now: 0 });
  assert.equal(result.status, "needs_attention", name);
  assert.ok(result.reasons.some((r) => r.code === code), name);
}

const waiting = decideRoute({
  policy: { ...policy, maxWaitMs: 1_000 },
  nodes: [node("preferred", { online: false }), node("fallback")],
  queuedAt: 100,
  now: 500,
});
assert.equal(waiting.status, "waiting");
assert.equal(waiting.status === "waiting" && waiting.waitUntil, 1_100);

const ephemeral = {
  provider: "fly",
  credentialAvailable: true,
  os: "linux",
  capabilities: ["git"],
  runtimes: ["codex"],
  modelProviders: [{ id: "openai", authenticated: true, models: ["gpt-5"] }],
  repositories: ["bivysh/bivy"],
  sandboxPolicies: ["workspace-write"],
  approvalPolicies: ["never"],
};
const ephemeralSelected = decideRoute({ policy: { ...policy, allowEphemeral: true }, nodes: [], ephemeral, queuedAt: 0, now: 0 });
assert.equal(ephemeralSelected.status, "selected");
assert.equal(ephemeralSelected.status === "selected" && ephemeralSelected.selected.kind, "ephemeral");
const noCredential = decideRoute({ policy: { ...policy, allowEphemeral: true }, nodes: [], ephemeral: { ...ephemeral, credentialAvailable: false }, queuedAt: 0, now: 0 });
assert.equal(noCredential.status, "needs_attention");
assert.ok(noCredential.reasons.some((r) => r.code === "ephemeral_credential_missing"));

console.log("routing: all tests passed");
