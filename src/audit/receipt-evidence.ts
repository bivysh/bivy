// SPDX-License-Identifier: AGPL-3.0-only
import type { AuditEvent } from "./index.js";

/** Collapse the node's payload-free audit events into the bounded governance
 * metadata accepted by Receipt v1. No tool arguments, prompts, transcripts,
 * diffs, file contents, commands, or secrets cross this boundary. */
export function receiptEvidenceFromAudit(events: AuditEvent[], storageReadable: boolean) {
  const approvals = events.filter((event) => event.kind === "approval.request");
  const decisions = events.filter((event) => event.kind === "approval.decision");
  const files = events.filter((event) => event.kind === "file.change").slice(-100).flatMap((event) => {
    if (typeof event.path !== "string" || !event.path) return [];
    return [{
      path: event.path.slice(0, 500),
      ...(typeof event.op === "string" ? { op: event.op.slice(0, 20) } : {}),
      added: Math.max(0, Math.trunc(Number(event.added) || 0)),
      removed: Math.max(0, Math.trunc(Number(event.removed) || 0)),
    }];
  });
  return {
    approvals: {
      requests: approvals.length,
      approved: decisions.filter((event) => event.approved === true).length,
      denied: decisions.filter((event) => event.approved === false).length,
    },
    fileChanges: {
      files,
      added: files.reduce((sum, file) => sum + file.added, 0),
      removed: files.reduce((sum, file) => sum + file.removed, 0),
    },
    auditHealth: {
      correlation: events.length ? "healthy" as const : "missing" as const,
      readableStorage: storageReadable ? "healthy" as const : "missing" as const,
      successfulWrites: storageReadable && events.length ? "healthy" as const : "missing" as const,
    },
  };
}

export interface ReceiptExecutionContext {
  profile: "trusted_workstation" | "isolated_customer_cloud" | "restricted";
  controller: "customer" | "bivy_hosted_provisioning";
  sandboxTier?: "read-only" | "workspace-write" | "danger-full-access";
  approvalMode?: "never" | "risky" | "always" | "autonomous";
  runtimeEnforcement?: string;
  toolInterception?: boolean;
  agentVersion?: string;
  correlation?: { runId: string; attempt: number; machineId: string };
}

/** Add only node-observed execution facts to the already bounded audit summary. */
export function receiptEvidenceForRun(events: AuditEvent[], storageReadable: boolean, context: ReceiptExecutionContext) {
  const marker = context.correlation
    ? [...events].reverse().find((event) => event.kind === "run.correlation"
      && event.runId === context.correlation!.runId
      && event.attempt === context.correlation!.attempt
      && event.machineId === context.correlation!.machineId)
    : undefined;
  const scopedEvents = context.correlation ? (marker ? events.filter((event) => event.ts >= marker.ts) : []) : events;
  const audit = receiptEvidenceFromAudit(scopedEvents, storageReadable);
  if (context.correlation && !marker) audit.auditHealth.correlation = "missing";
  const enforcement = context.runtimeEnforcement || "unavailable";
  const sandboxClass = enforcement === "native-sandbox" ? "enforced" as const
    : enforcement === "tool-controls" ? "observed" as const : "unavailable" as const;
  return {
    ...audit,
    execution: {
      profile: context.profile,
      controller: context.controller,
      ...(context.agentVersion ? { agentVersion: context.agentVersion } : {}),
      modelVersionStatus: "unknown" as const,
    },
    protection: {
      effective: {
        executionProfile: context.profile,
        ...(context.sandboxTier ? { sandboxTier: context.sandboxTier } : {}),
        ...(context.approvalMode ? { approvalMode: context.approvalMode } : {}),
        runtimeEnforcement: enforcement,
      },
      capabilities: [
        { capability: "sandbox" as const, evidenceClass: sandboxClass, mechanism: enforcement },
        { capability: "approval" as const, evidenceClass: context.toolInterception ? "enforced" as const : "unavailable" as const, mechanism: context.toolInterception ? "runtime tool interception" : "not observed" },
      ],
    },
  };
}
