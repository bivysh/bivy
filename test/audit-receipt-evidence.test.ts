// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { test } from "node:test";
import { receiptEvidenceForRun, receiptEvidenceFromAudit } from "../src/audit/receipt-evidence.js";

test("maps only bounded approval and file metadata into Receipt evidence", () => {
  const evidence = receiptEvidenceFromAudit([
    { ts: 1, kind: "approval.request", session: "s", tool: "shell" },
    { ts: 2, kind: "approval.decision", session: "s", requestId: "r", approved: true },
    { ts: 3, kind: "file.change", session: "s", path: "src/app.ts", op: "modified", added: 4, removed: 2 },
    { ts: 4, kind: "tool.call", session: "s", tool: "shell", payload: "must not cross" },
  ], true);
  assert.deepEqual(evidence.approvals, { requests: 1, approved: 1, denied: 0 });
  assert.deepEqual(evidence.fileChanges, { files: [{ path: "src/app.ts", op: "modified", added: 4, removed: 2 }], added: 4, removed: 2 });
  assert.equal(JSON.stringify(evidence).includes("payload"), false);
  assert.equal(evidence.auditHealth.correlation, "healthy");
});

test("reports missing audit health instead of inventing evidence", () => {
  const evidence = receiptEvidenceFromAudit([], false);
  assert.deepEqual(evidence.auditHealth, { correlation: "missing", readableStorage: "missing", successfulWrites: "missing" });
});

test("adds node-observed execution and effective protection without content", () => {
  const evidence = receiptEvidenceForRun([], true, {
    profile: "isolated_customer_cloud", controller: "bivy_hosted_provisioning",
    sandboxTier: "workspace-write", approvalMode: "risky",
    runtimeEnforcement: "native-sandbox", toolInterception: true,
  });
  assert.equal(evidence.execution.profile, "isolated_customer_cloud");
  assert.equal(evidence.execution.modelVersionStatus, "unknown");
  assert.equal(evidence.protection.effective.sandboxTier, "workspace-write");
  assert.deepEqual(evidence.protection.capabilities.map(({ capability, evidenceClass }) => ({ capability, evidenceClass })), [
    { capability: "sandbox", evidenceClass: "enforced" },
    { capability: "approval", evidenceClass: "enforced" },
  ]);
});

test("scopes audit evidence to the exact Run attempt and Machine marker", () => {
  const context = {
    profile: "trusted_workstation" as const,
    controller: "customer" as const,
    correlation: { runId: "run-2", attempt: 2, machineId: "machine-1" },
  };
  const evidence = receiptEvidenceForRun([
    { ts: 1, kind: "approval.decision", session: "s", approved: false },
    { ts: 2, kind: "run.correlation", session: "s", runId: "run-2", attempt: 1, machineId: "machine-1" },
    { ts: 3, kind: "approval.decision", session: "s", approved: false },
    { ts: 4, kind: "run.correlation", session: "s", runId: "run-2", attempt: 2, machineId: "machine-1" },
    { ts: 5, kind: "approval.request", session: "s" },
    { ts: 6, kind: "approval.decision", session: "s", approved: true },
  ], true, context);
  assert.deepEqual(evidence.approvals, { requests: 1, approved: 1, denied: 0 });
  assert.equal(evidence.auditHealth.correlation, "healthy");

  const wrongMachine = receiptEvidenceForRun([
    { ts: 4, kind: "run.correlation", session: "s", runId: "run-2", attempt: 2, machineId: "machine-other" },
    { ts: 5, kind: "approval.decision", session: "s", approved: true },
  ], true, context);
  assert.deepEqual(wrongMachine.approvals, { requests: 0, approved: 0, denied: 0 });
  assert.equal(wrongMachine.auditHealth.correlation, "missing");
});
