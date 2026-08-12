// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { projectReceiptV1, receiptV1FromRun, receiptV1Json, type ReceiptV1ProjectionInput } from "../src/receipt-v1.js";
import type { Run } from "../src/run.js";

const base = (over: Partial<ReceiptV1ProjectionInput["run"]> = {}): ReceiptV1ProjectionInput => ({
  receiptId: "receipt-run-1",
  createdAt: "2026-08-13T12:10:00.000Z",
  run: {
    id: "run-1",
    source: "github:issue",
    status: "succeeded",
    createdAt: "2026-08-13T12:00:00.000Z",
    startedAt: "2026-08-13T12:01:00.000Z",
    completedAt: "2026-08-13T12:05:00.000Z",
    attempt: 2,
    repo: "bivy/example",
    issueNumber: 12,
    claimedByNodeId: "node-1",
    runtimeId: "codex",
    model: "gpt-5",
    approvalMode: "risky",
    sandbox: "workspace-write",
    output: { sessionId: "session-1", branch: "bivy/issue-12" },
    events: [{ at: "2026-08-13T12:02:00.000Z", kind: "retry", summary: "untrusted free-form detail" }],
    ...over,
  },
});

describe("Receipt v1 projection", () => {
  it("projects an existing canonical Run as an honest partial Receipt", () => {
    const run: Run = {
      id: "run-1", origin: { projection: "automation_run", status: "succeeded" }, lifecycle: "finished",
      outcome: { kind: "changes_ready", label: "Changes ready", tone: "success", terminal: true, reviewable: true }, attempt: 1,
      title: "Fix issue", source: { kind: "github:issue", reference: "bivy/example#12" },
      sessionId: "session-1", machine: { id: "node-1", name: "Build machine" },
      timestamps: { createdAt: "2026-08-13T12:00:00Z", startedAt: "2026-08-13T12:01:00Z", completedAt: "2026-08-13T12:02:00Z" },
      durationMs: 60_000, requested: { runtimeId: "codex", sandbox: "workspace-write" }, checks: [], events: [],
      references: { branch: "bivy/issue-12" }, actions: [],
    };
    const receipt = receiptV1FromRun(run, "2026-08-13T12:03:00Z");
    expect(receipt.runId).toBe("run-1");
    expect(receipt.execution.machineName).toBe("Build machine");
    expect(receipt.changes.branch).toBe("bivy/issue-12");
    expect(receipt.completeness).toBe("partial");
    expect(receipt.missingEvidence).toContain("effective_protection");
  });

  it("stays partial when current run evidence lacks audit and effective protection", () => {
    const receipt = projectReceiptV1(base());
    expect(receipt.completeness).toBe("partial");
    expect(receipt.protection.requested).toEqual({ sandboxTier: "workspace-write", approvalMode: "risky" });
    expect(receipt.protection.effective).toEqual({});
    expect(receipt.run.retryFallbackReasons).toEqual(["retry"]);
    expect(JSON.stringify(receipt)).not.toContain("untrusted free-form detail");
    expect(receipt.missingEvidence).toEqual(expect.arrayContaining(["effective_protection", "approval_decisions", "file_change_summary", "audit_correlation", "audit_storage", "audit_writes"]));
  });

  it("cannot report complete until approvals and file changes are correlated", () => {
    const input = base({ checks: [{ name: "test", status: "passed" }] });
    input.execution = { machineName: "Build machine", profile: "restricted", controller: "customer", modelVersionStatus: "available" };
    input.protection = {
      effective: { executionProfile: "restricted", sandboxTier: "read-only", approvalMode: "always", runtimeEnforcement: "native" },
      capabilities: [{ capability: "sandbox", evidenceClass: "enforced", mechanism: "native" }],
    };
    input.auditHealth = { correlation: "healthy", readableStorage: "healthy", successfulWrites: "healthy" };
    const receipt = projectReceiptV1(input);
    expect(receipt.completeness).toBe("partial");
    expect(receipt.missingEvidence).toEqual(expect.arrayContaining(["approval_decisions", "file_change_summary", "check_details"]));
  });

  it("carries correlated approval and bounded file evidence into the Receipt", () => {
    const input = base();
    input.governance = {
      approvals: { requests: 2, approved: 1, denied: 1 },
      fileChanges: { files: [{ path: "src/app.ts", op: "modified", added: 4, removed: 2 }], added: 4, removed: 2 },
      auditHealth: { correlation: "healthy", readableStorage: "healthy", successfulWrites: "healthy" },
    };
    input.auditHealth = input.governance.auditHealth;
    const receipt = projectReceiptV1(input);
    expect(receipt.approvals).toEqual({ requests: 2, approved: 1, denied: 1 });
    expect(receipt.changes.files[0]?.path).toBe("src/app.ts");
    expect(receipt.missingEvidence).not.toContain("approval_decisions");
    expect(receipt.missingEvidence).not.toContain("file_change_summary");
  });

  it("does not infer a terminal outcome from process completion alone", () => {
    const receipt = projectReceiptV1(base({ output: { sessionId: "session-1" }, checks: undefined, events: [{ at: "2026-08-13T12:05:00Z", kind: "completed", summary: "process exited" }] }));
    expect(receipt.run.terminalOutcome).toBeUndefined();
    expect(receipt.missingEvidence).toContain("terminal_outcome");
    expect(receipt.observationLimitations.map((l) => l.code)).toContain("run_in_progress");
  });

  it("keeps requested/effective settings distinct and preserves evidence classes", () => {
    const input = base();
    input.execution = { machineName: "Build machine", profile: "restricted", controller: "customer", modelVersionStatus: "available" };
    input.protection = {
      effective: { executionProfile: "restricted", sandboxTier: "read-only", approvalMode: "always", runtimeEnforcement: "guardian" },
      capabilities: [
        { capability: "sandbox", evidenceClass: "enforced", mechanism: "guardian" },
        { capability: "network", evidenceClass: "observed" },
        { capability: "credential_custody", evidenceClass: "unavailable" },
      ],
    };
    const receipt = projectReceiptV1(input);
    expect(receipt.protection.requested.sandboxTier).toBe("workspace-write");
    expect(receipt.protection.effective.sandboxTier).toBe("read-only");
    expect(receipt.protection.capabilities.map((c) => c.evidenceClass)).toEqual(["enforced", "observed", "unavailable"]);
  });

  it("makes a missing audit write partial and visible", () => {
    const input = base();
    input.auditHealth = { correlation: "healthy", readableStorage: "healthy", successfulWrites: "missing" };
    const receipt = projectReceiptV1(input);
    expect(receipt.completeness).toBe("partial");
    expect(receipt.missingEvidence).toContain("audit_writes");
    expect(receipt.observationLimitations.map((l) => l.code)).toContain("audit_write_failed");
  });

  it("rejects prohibited keys and oversized values, including beneath unknown fields", () => {
    expect(() => projectReceiptV1({ ...base(), harmlessUnknown: { rawToolOutput: "oops" } } as unknown as ReceiptV1ProjectionInput)).toThrow(/prohibited Receipt field/);
    expect(() => projectReceiptV1({ ...base(), receiptId: "x".repeat(201) })).toThrow(/at most 200/);
    const withPrompt = base();
    (withPrompt.run as unknown as Record<string, unknown>).prompt = "do not export";
    expect(() => projectReceiptV1(withPrompt)).toThrow(/prohibited Receipt field/);
  });

  it("exports only the sanitized Receipt, excluding benign unknown fields and enclosing records", () => {
    const receipt = projectReceiptV1(base()) as unknown as Record<string, unknown>;
    receipt.queueItem = { title: "source content", label: "bivy/main" };
    (receipt.run as Record<string, unknown>).futureField = "not in v1";
    const exported = JSON.parse(receiptV1Json(receipt as never));
    expect(exported.schemaVersion).toBe("receipt.v1");
    expect(exported.receiptId).toBe("receipt-run-1");
    expect(exported.queueItem).toBeUndefined();
    expect(exported.run.futureField).toBeUndefined();
    expect(JSON.stringify(exported)).not.toContain("source content");
  });

  it("rejects prohibited fields added after projection before JSON export", () => {
    const receipt = projectReceiptV1(base()) as unknown as Record<string, unknown>;
    receipt.transcript = "should never leave the client";
    expect(() => receiptV1Json(receipt as never)).toThrow(/prohibited Receipt field/);
  });
});
