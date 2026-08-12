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
