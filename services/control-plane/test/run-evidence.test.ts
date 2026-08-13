// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizeEvidencePatch } from "../src/run-evidence.js";

test("evidence accepts the bounded metadata needed for an outcome report", () => {
  const patch = sanitizeEvidencePatch({
    routingReason: "queue label",
    output: { sessionId: "session_1", branch: "bivy/issue-153", prUrl: "https://github.com/bivysh/bivy/pull/200", checkpoint: "abc123", commit: "def456" },
    checks: [{ name: "unit tests", commandHash: "sha256:123", status: "passed", exitCode: 0 }],
    events: [{ at: "2026-07-26T00:00:00.000Z", kind: "pull_request", summary: "Pull request opened.", attempt: 1 }],
    receiptEvidence: {
      approvals: { requests: 2, approved: 1, denied: 1 },
      fileChanges: { files: [{ path: "src/app.ts", op: "modified", added: 4, removed: 2 }], added: 4, removed: 2 },
      auditHealth: { correlation: "healthy", readableStorage: "healthy", successfulWrites: "healthy" },
      execution: { profile: "isolated_customer_cloud", controller: "bivy_hosted_provisioning", modelVersionStatus: "unknown" },
      protection: {
        effective: { executionProfile: "isolated_customer_cloud", sandboxTier: "workspace-write", approvalMode: "risky", runtimeEnforcement: "native-sandbox" },
        capabilities: [{ capability: "sandbox", evidenceClass: "enforced", mechanism: "native-sandbox" }],
      },
    },
  });
  assert.equal(patch.routingReason, "queue label");
  assert.equal(patch.output?.branch, "bivy/issue-153");
  assert.equal(patch.output?.checkpoint, "abc123");
  assert.equal(patch.output?.commit, "def456");
  assert.equal(patch.events?.[0]?.kind, "pull_request");
  assert.equal(patch.checks?.[0]?.exitCode, 0);
  assert.equal(patch.receiptEvidence?.fileChanges.files[0]?.path, "src/app.ts");
  assert.equal(patch.receiptEvidence?.approvals.denied, 1);
  assert.equal(patch.receiptEvidence?.execution?.profile, "isolated_customer_cloud");
  assert.equal(patch.receiptEvidence?.protection?.effective?.runtimeEnforcement, "native-sandbox");
  assert.equal(patch.receiptEvidence?.protection?.capabilities?.[0]?.evidenceClass, "enforced");
});

test("evidence rejects sensitive fields at every accepted level", () => {
  for (const payload of [
    { prompt: "private request" },
    { output: { diff: "private patch" } },
    { output: { rawCommand: "npm test" } },
    { events: [{ kind: "completed", summary: "done", toolOutput: "private" }] },
    { checks: [{ name: "test", status: "passed", rawCommand: "npm test" }] },
    { receiptEvidence: { transcript: "private" } },
    { receiptEvidence: { fileChanges: { files: [{ path: "src/app.ts", diff: "private patch" }] } } },
    { receiptEvidence: { protection: { capabilities: [{ capability: "tool", evidenceClass: "observed", rawToolOutput: "private" }] } } },
  ]) {
    assert.throws(() => sanitizeEvidencePatch(payload), /sensitive evidence field rejected/);
  }
});

test("evidence drops output fields outside the allowlist instead of storing them", () => {
  const patch = sanitizeEvidencePatch({ output: { branch: "bivy/issue-1", notAllowlisted: "should be dropped" } });
  assert.equal(patch.output?.branch, "bivy/issue-1");
  assert.equal(Object.hasOwn(patch.output ?? {}, "notAllowlisted"), false);
});

test("evidence truncates summaries and caps histories per call", () => {
  const patch = sanitizeEvidencePatch({
    events: Array.from({ length: 150 }, (_, i) => ({ kind: "retry", summary: "x".repeat(500), attempt: i + 1 })),
    checks: Array.from({ length: 75 }, (_, i) => ({ name: `check ${i}`, status: "passed" })),
  });
  assert.equal(patch.events?.length, 100);
  assert.equal(patch.events?.[0]?.summary.length, 240);
  assert.equal(patch.checks?.length, 50);
});

test("evidence rejects an unrecognized event kind rather than storing an unknown lifecycle stage", () => {
  const patch = sanitizeEvidencePatch({ events: [{ kind: "totally_made_up", summary: "should be dropped" }] });
  assert.equal(patch.events, undefined);
});

test("evidence ignores an empty/non-object payload instead of throwing", () => {
  assert.deepEqual(sanitizeEvidencePatch(null), {});
  assert.deepEqual(sanitizeEvidencePatch(undefined), {});
  assert.deepEqual(sanitizeEvidencePatch("nope"), {});
  assert.deepEqual(sanitizeEvidencePatch([1, 2, 3]), {});
  assert.deepEqual(sanitizeEvidencePatch({}), {});
});
