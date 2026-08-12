// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

import type { GithubQueueItem } from "./account.js";
import type { Run } from "./run.js";

/** Receipt v1 is an observation report, not an attestation.  This module is a
 * pure projection over the control plane's already-sanitized run metadata. */
export const RECEIPT_V1_SCHEMA_VERSION = "receipt.v1" as const;

export type ReceiptEvidenceClass = "enforced" | "observed" | "unavailable";
export type ReceiptCompleteness = "complete" | "partial";
export type ReceiptAuditState = "healthy" | "missing" | "unknown";
export type ReceiptMissingEvidence =
  | "run_timing" | "terminal_outcome" | "session_correlation"
  | "machine_identity" | "execution_identity" | "effective_protection"
  | "protection_evidence" | "approval_decisions" | "change_evidence" | "file_change_summary" | "check_details"
  | "audit_correlation" | "audit_storage" | "audit_writes";
export type ReceiptLimitationCode =
  | "run_in_progress" | "session_not_correlated" | "machine_identity_not_reported"
  | "execution_identity_not_reported" | "effective_protection_not_observed" | "approval_decisions_not_correlated"
  | "governance_events_not_correlated" | "change_metadata_not_reported"
  | "check_metadata_incomplete" | "audit_health_unknown" | "audit_write_failed";

export interface ReceiptV1ProjectionInput {
  receiptId: string;
  /** The instant this projection was requested. It is supplied by the caller so
   * projection stays deterministic and testable. */
  createdAt: string;
  run: Pick<GithubQueueItem,
    "id" | "source" | "status" | "repo" | "issueNumber" | "externalId"
    | "createdAt" | "claimedAt" | "startedAt" | "completedAt" | "attempt"
    | "claimedByNodeId" | "runtimeId" | "model" | "approvalMode" | "sandbox"
    | "output" | "checks" | "events">;
  execution?: {
    machineName?: string;
    profile?: "trusted_workstation" | "isolated_customer_cloud" | "restricted";
    controller?: "customer" | "bivy_hosted_provisioning";
    provider?: string;
    region?: string;
    image?: string;
    agentVersion?: string;
    modelVersionStatus?: "available" | "unavailable" | "unknown";
  };
  protection?: {
    effective?: {
      executionProfile?: "trusted_workstation" | "isolated_customer_cloud" | "restricted";
      sandboxTier?: "read-only" | "workspace-write" | "danger-full-access";
      approvalMode?: "never" | "risky" | "always" | "autonomous";
      runtimeEnforcement?: string;
      trustModes?: string[];
    };
    capabilities?: Array<{
      capability: "sandbox" | "approval" | "tool" | "network" | "credential_custody" | "runtime_policy";
      evidenceClass: ReceiptEvidenceClass;
      mechanism?: string;
    }>;
  };
  auditHealth?: {
    correlation: ReceiptAuditState;
    readableStorage: ReceiptAuditState;
    successfulWrites: ReceiptAuditState;
  };
  governance?: NonNullable<GithubQueueItem["receiptEvidence"]>;
}

export interface ReceiptV1 {
  schemaVersion: typeof RECEIPT_V1_SCHEMA_VERSION;
  receiptId: string;
  runId: string;
  sessionId?: string;
  createdAt: string;
  completeness: ReceiptCompleteness;
  run: {
    startedAt?: string;
    endedAt?: string;
    durationMs?: number;
    terminalOutcome?: "succeeded" | "changes_ready" | "checks_failed" | "failed" | "cancelled";
    outcomeReason?: "checks_passed" | "check_failed" | "artifact_recorded" | "run_failed" | "run_cancelled";
    attempts: number;
    retryFallbackReasons: Array<"retry" | "fallback">;
    source: { kind: string; reference?: string };
  };
  execution: {
    machineId?: string;
    machineName?: string;
    profile?: "trusted_workstation" | "isolated_customer_cloud" | "restricted";
    controller?: "customer" | "bivy_hosted_provisioning";
    provider?: string;
    region?: string;
    image?: string;
    agentId?: string;
    agentVersion?: string;
    modelId?: string;
    modelVersionStatus?: "available" | "unavailable" | "unknown";
  };
  protection: {
    requested: { sandboxTier?: string; approvalMode?: string };
    effective: { executionProfile?: string; sandboxTier?: string; approvalMode?: string; runtimeEnforcement?: string; trustModes?: string[] };
    capabilities: Array<{ capability: string; evidenceClass: ReceiptEvidenceClass; mechanism?: string }>;
  };
  approvals: { requests: number; approved: number; denied: number };
  changes: { branch?: string; commit?: string; pullRequest?: string; checkpoint?: string; artifact?: string; files: Array<{ path: string; op?: string; added?: number; removed?: number }>; added: number; removed: number };
  checks: Array<{ name: string; commandHash?: string; status: "passed" | "failed" | "skipped"; durationMs?: number; exitCode?: number }>;
  auditHealth: { correlation: ReceiptAuditState; readableStorage: ReceiptAuditState; successfulWrites: ReceiptAuditState };
  missingEvidence: ReceiptMissingEvidence[];
  observationLimitations: Array<{ code: ReceiptLimitationCode; message: string }>;
}

const MAX = { id: 200, text: 240, ref: 500, list: 100, checks: 50 } as const;
const PROHIBITED_KEY = /prompt|transcript|reasoning|diff|secret|token|stdout|stderr|raw.?output|raw.?input|raw.?command|raw.?tool|file.?content|repository.?content/i;

function rejectProhibited(value: unknown, seen = new Set<object>()): void {
  if (!value || typeof value !== "object") return;
  if (seen.has(value as object)) throw new Error("cyclic Receipt evidence rejected");
  seen.add(value as object);
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (PROHIBITED_KEY.test(key)) throw new Error(`prohibited Receipt field rejected: ${key}`);
    rejectProhibited(child, seen);
  }
  seen.delete(value as object);
}

function bounded(value: unknown, field: string, max: number = MAX.text): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > max) throw new Error(`${field} must be a string of at most ${max} characters`);
  return value;
}
function required(value: unknown, field: string, max: number = MAX.id): string {
  const result = bounded(value, field, max)?.trim();
  if (!result) throw new Error(`${field} is required`);
  return result;
}
function instant(value: unknown, field: string): string | undefined {
  const text = bounded(value, field, 40);
  if (!text) return undefined;
  if (!Number.isFinite(Date.parse(text))) throw new Error(`${field} must be an ISO date-time`);
  return text;
}
function addMissing(target: ReceiptMissingEvidence[], value: ReceiptMissingEvidence): void {
  if (!target.includes(value)) target.push(value);
}

const LIMITATIONS: Record<ReceiptLimitationCode, string> = {
  run_in_progress: "The Run has no evidence-backed terminal outcome yet.",
  session_not_correlated: "Run evidence was not correlated to an underlying Session.",
  machine_identity_not_reported: "A customer-readable Machine identity was not reported with this Run.",
  execution_identity_not_reported: "Provider, runtime, or model version evidence was not fully reported.",
  effective_protection_not_observed: "Requested protection is visible, but its effective settings were not observed.",
  approval_decisions_not_correlated: "Approval and denial decisions were not durably correlated to this Run.",
  governance_events_not_correlated: "Governance audit events were not durably correlated to this Run.",
  change_metadata_not_reported: "A bounded file/change summary or explicit no-change evidence was not reported.",
  check_metadata_incomplete: "One or more checks lack required, timeout, or other deterministic metadata.",
  audit_health_unknown: "Audit storage health or successful writes could not be confirmed.",
  audit_write_failed: "At least one required audit write or readable-storage check is missing.",
};

/** Build the bounded, allowlisted Receipt projection. Unknown source fields are
 * ignored; prohibited field names and oversized values fail closed. */
export function projectReceiptV1(input: ReceiptV1ProjectionInput): ReceiptV1 {
  rejectProhibited(input);
  if (!input || typeof input !== "object" || !input.run || typeof input.run !== "object") throw new Error("Receipt evidence is required");
  const receiptId = required(input.receiptId, "receiptId");
  const runId = required(input.run.id, "run.id");
  const createdAt = required(instant(input.createdAt, "createdAt"), "createdAt", 40);
  const sessionId = bounded(input.run.output?.sessionId, "sessionId", MAX.id);
  const startedAt = instant(input.run.startedAt ?? input.run.claimedAt, "run.startedAt");
  const endedAt = instant(input.run.completedAt, "run.completedAt");
  const durationMs = startedAt && endedAt ? Date.parse(endedAt) - Date.parse(startedAt) : undefined;
  if (durationMs !== undefined && durationMs < 0) throw new Error("Run end precedes start");

  const checks = (input.run.checks ?? []).slice(0, MAX.checks).map((check, i) => ({
    name: required(check.name, `checks[${i}].name`, 120),
    ...(bounded(check.commandHash, `checks[${i}].commandHash`, 128) ? { commandHash: check.commandHash } : {}),
    status: check.status,
    ...(typeof check.durationMs === "number" ? { durationMs: check.durationMs } : {}),
    ...(typeof check.exitCode === "number" ? { exitCode: check.exitCode } : {}),
  }));
  const terminalStatus = ["succeeded", "failed", "cancelled", "done"].includes(input.run.status);
  let terminalOutcome: ReceiptV1["run"]["terminalOutcome"];
  let outcomeReason: ReceiptV1["run"]["outcomeReason"];
  if (input.run.status === "cancelled") { terminalOutcome = "cancelled"; outcomeReason = "run_cancelled"; }
  else if (terminalStatus && checks.some((c) => c.status === "failed")) { terminalOutcome = "checks_failed"; outcomeReason = "check_failed"; }
  else if (input.run.status === "failed") { terminalOutcome = "failed"; outcomeReason = "run_failed"; }
  else if (terminalStatus && (input.run.output?.branch || input.run.output?.commit || input.run.output?.prUrl || input.run.output?.checkpoint || input.run.output?.artifactUrl)) {
    terminalOutcome = "changes_ready"; outcomeReason = "artifact_recorded";
  } else if (input.run.status === "succeeded" && checks.length > 0 && checks.every((c) => c.status === "passed")) {
    terminalOutcome = "succeeded"; outcomeReason = "checks_passed";
  }

  const reference = input.run.repo
    ? `${required(input.run.repo, "run.repo", 200)}${Number.isInteger(input.run.issueNumber) ? `#${input.run.issueNumber}` : ""}`
    : bounded(input.run.externalId, "run.externalId", 200);
  const retryFallbackReasons = (input.run.events ?? []).filter((e) => e.kind === "retry" || e.kind === "fallback").slice(-MAX.list).map((e) => e.kind as "retry" | "fallback");
  const effective = input.protection?.effective;
  const capabilities = (input.protection?.capabilities ?? []).slice(0, 20).map((c, i) => ({
    capability: required(c.capability, `capabilities[${i}].capability`, 40),
    evidenceClass: c.evidenceClass,
    ...(bounded(c.mechanism, `capabilities[${i}].mechanism`, 120) ? { mechanism: c.mechanism } : {}),
  }));
  const auditHealth = input.auditHealth ?? { correlation: "unknown", readableStorage: "unknown", successfulWrites: "unknown" } as const;
  const governance = input.governance;
  const changes = {
    ...(bounded(input.run.output?.branch, "changes.branch", MAX.ref) ? { branch: input.run.output!.branch } : {}),
    ...(bounded(input.run.output?.commit, "changes.commit", 200) ? { commit: input.run.output!.commit } : {}),
    ...(bounded(input.run.output?.prUrl, "changes.pullRequest", MAX.ref) ? { pullRequest: input.run.output!.prUrl } : {}),
    ...(bounded(input.run.output?.checkpoint, "changes.checkpoint", MAX.ref) ? { checkpoint: input.run.output!.checkpoint } : {}),
    ...(bounded(input.run.output?.artifactUrl, "changes.artifact", MAX.ref) ? { artifact: input.run.output!.artifactUrl } : {}),
    files: (governance?.fileChanges.files ?? []).slice(0, MAX.list).map((file, i) => ({ path: required(file.path, `changes.files[${i}].path`, MAX.ref), ...(bounded(file.op, `changes.files[${i}].op`, 20) ? { op: file.op } : {}), ...(typeof file.added === "number" ? { added: file.added } : {}), ...(typeof file.removed === "number" ? { removed: file.removed } : {}) })),
    added: governance?.fileChanges.added ?? 0,
    removed: governance?.fileChanges.removed ?? 0,
  };

  const missing: ReceiptMissingEvidence[] = [];
  if (!startedAt || !endedAt) addMissing(missing, "run_timing");
  if (!terminalOutcome) addMissing(missing, "terminal_outcome");
  if (!sessionId) addMissing(missing, "session_correlation");
  if (!input.run.claimedByNodeId || !input.execution?.machineName) addMissing(missing, "machine_identity");
  if (!input.execution?.profile || !input.execution.controller || !input.run.runtimeId || !input.run.model || !input.execution.modelVersionStatus) addMissing(missing, "execution_identity");
  if (!effective) addMissing(missing, "effective_protection");
  if (!capabilities.length) addMissing(missing, "protection_evidence");
  // Current Run evidence has no correlated approval-decision list or bounded
  // file/change summary. Keep every projection partial until those fields are
  // added from the node audit stream; branch/commit references are not enough.
  if (!governance) addMissing(missing, "approval_decisions");
  if (!Object.keys(changes).length) addMissing(missing, "change_evidence");
  if (!governance) addMissing(missing, "file_change_summary");
  if (checks.some(() => true)) addMissing(missing, "check_details"); // current RunCheck lacks required + timeout evidence
  if (auditHealth.correlation !== "healthy") addMissing(missing, "audit_correlation");
  if (auditHealth.readableStorage !== "healthy") addMissing(missing, "audit_storage");
  if (auditHealth.successfulWrites !== "healthy") addMissing(missing, "audit_writes");

  const limitationCodes: ReceiptLimitationCode[] = [];
  if (!terminalOutcome) limitationCodes.push("run_in_progress");
  if (!sessionId) limitationCodes.push("session_not_correlated");
  if (missing.includes("machine_identity")) limitationCodes.push("machine_identity_not_reported");
  if (missing.includes("execution_identity")) limitationCodes.push("execution_identity_not_reported");
  if (missing.includes("effective_protection")) limitationCodes.push("effective_protection_not_observed");
  if (missing.includes("approval_decisions")) limitationCodes.push("approval_decisions_not_correlated");
  if (missing.includes("audit_correlation")) limitationCodes.push("governance_events_not_correlated");
  if (missing.includes("change_evidence") || missing.includes("file_change_summary")) limitationCodes.push("change_metadata_not_reported");
  if (missing.includes("check_details")) limitationCodes.push("check_metadata_incomplete");
  if ([auditHealth.correlation, auditHealth.readableStorage, auditHealth.successfulWrites].includes("unknown")) limitationCodes.push("audit_health_unknown");
  if ([auditHealth.readableStorage, auditHealth.successfulWrites].includes("missing")) limitationCodes.push("audit_write_failed");

  return {
    schemaVersion: RECEIPT_V1_SCHEMA_VERSION, receiptId, runId, ...(sessionId ? { sessionId } : {}), createdAt,
    completeness: missing.length ? "partial" : "complete",
    run: {
      ...(startedAt ? { startedAt } : {}), ...(endedAt ? { endedAt } : {}), ...(durationMs !== undefined ? { durationMs } : {}),
      ...(terminalOutcome ? { terminalOutcome, outcomeReason } : {}),
      attempts: Math.max(1, Math.min(100, Math.trunc(input.run.attempt ?? 1))), retryFallbackReasons,
      source: { kind: required(input.run.source, "run.source", 40), ...(reference ? { reference } : {}) },
    },
    execution: {
      ...(input.run.claimedByNodeId ? { machineId: required(input.run.claimedByNodeId, "machineId") } : {}),
      ...(input.execution?.machineName ? { machineName: required(input.execution.machineName, "machineName", 120) } : {}),
      ...(input.execution?.profile ? { profile: input.execution.profile } : {}), ...(input.execution?.controller ? { controller: input.execution.controller } : {}),
      ...(input.execution?.provider ? { provider: required(input.execution.provider, "provider", 80) } : {}), ...(input.execution?.region ? { region: required(input.execution.region, "region", 80) } : {}),
      ...(input.execution?.image ? { image: required(input.execution.image, "image", 160) } : {}), ...(input.run.runtimeId ? { agentId: required(input.run.runtimeId, "agentId", 120) } : {}),
      ...(input.execution?.agentVersion ? { agentVersion: required(input.execution.agentVersion, "agentVersion", 80) } : {}), ...(input.run.model ? { modelId: required(input.run.model, "modelId", 160) } : {}),
      ...(input.execution?.modelVersionStatus ? { modelVersionStatus: input.execution.modelVersionStatus } : {}),
    },
    protection: {
      requested: { ...(input.run.sandbox ? { sandboxTier: input.run.sandbox } : {}), ...(input.run.approvalMode ? { approvalMode: input.run.approvalMode } : {}) },
      effective: effective ? { ...effective, ...(effective.trustModes ? { trustModes: effective.trustModes.slice(0, 20).map((v, i) => required(v, `trustModes[${i}]`, 80)) } : {}) } : {},
      capabilities,
    },
    approvals: governance?.approvals ?? { requests: 0, approved: 0, denied: 0 }, changes, checks, auditHealth, missingEvidence: missing,
    observationLimitations: limitationCodes.map((code) => ({ code, message: LIMITATIONS[code] })),
  };
}

/** Project the canonical account-facing Run into an honest Receipt. This is the
 * bridge used by the Run route while richer node audit evidence is being
 * correlated. Missing effective protection/audit evidence remains explicit, so
 * an existing durable Run can produce a useful partial Receipt without the UI
 * inventing facts. */
export function receiptV1FromRun(run: Run, createdAt: string): ReceiptV1 {
  const source = run.source.kind || "unknown";
  const reference = run.source.reference;
  const repoMatch = reference?.match(/^([^#]+)#(\d+)$/);
  return projectReceiptV1({
    receiptId: `receipt-${run.id}`,
    createdAt,
    run: {
      id: run.id,
      source,
      status: run.origin.status,
      createdAt: run.timestamps.createdAt,
      claimedAt: run.timestamps.claimedAt,
      startedAt: run.timestamps.startedAt,
      completedAt: run.timestamps.completedAt,
      attempt: run.attempt,
      ...(repoMatch ? { repo: repoMatch[1], issueNumber: Number(repoMatch[2]) } : reference ? { externalId: reference } : {}),
      ...(run.machine?.id ? { claimedByNodeId: run.machine.id } : {}),
      ...(run.requested.runtimeId ? { runtimeId: run.requested.runtimeId } : {}),
      ...(run.requested.model ? { model: run.requested.model } : {}),
      ...(run.requested.approvalMode ? { approvalMode: run.requested.approvalMode } : {}),
      ...(run.requested.sandbox ? { sandbox: run.requested.sandbox } : {}),
      output: {
        ...(run.sessionId ? { sessionId: run.sessionId } : {}),
        ...(run.references.branch ? { branch: run.references.branch } : {}),
        ...(run.references.commit ? { commit: run.references.commit } : {}),
        ...(run.references.pullRequest ? { prUrl: run.references.pullRequest } : {}),
        ...(run.references.checkpoint ? { checkpoint: run.references.checkpoint } : {}),
        ...(run.references.artifact ? { artifactUrl: run.references.artifact } : {}),
      },
      checks: run.checks,
      events: run.events,
    },
    ...(run.machine?.name ? { execution: { machineName: run.machine.name } } : {}),
    ...(run.receiptEvidence ? { governance: run.receiptEvidence, auditHealth: run.receiptEvidence.auditHealth } : {}),
  });
}

/** Defense-in-depth export. Re-projecting through an explicit allowlist strips
 * benign unknown properties; prohibited properties still fail closed. */
export function receiptV1Json(receipt: ReceiptV1): string {
  rejectProhibited(receipt);
  const clean: ReceiptV1 = {
    schemaVersion: RECEIPT_V1_SCHEMA_VERSION,
    receiptId: required(receipt.receiptId, "receiptId"), runId: required(receipt.runId, "runId"),
    ...(bounded(receipt.sessionId, "sessionId", MAX.id) ? { sessionId: receipt.sessionId } : {}),
    createdAt: required(instant(receipt.createdAt, "createdAt"), "createdAt", 40), completeness: receipt.completeness,
    run: {
      ...(instant(receipt.run.startedAt, "run.startedAt") ? { startedAt: receipt.run.startedAt } : {}),
      ...(instant(receipt.run.endedAt, "run.endedAt") ? { endedAt: receipt.run.endedAt } : {}),
      ...(typeof receipt.run.durationMs === "number" ? { durationMs: receipt.run.durationMs } : {}),
      ...(receipt.run.terminalOutcome ? { terminalOutcome: receipt.run.terminalOutcome } : {}),
      ...(receipt.run.outcomeReason ? { outcomeReason: receipt.run.outcomeReason } : {}),
      attempts: receipt.run.attempts,
      retryFallbackReasons: receipt.run.retryFallbackReasons.slice(0, MAX.list),
      source: { kind: required(receipt.run.source.kind, "run.source.kind", 40), ...(bounded(receipt.run.source.reference, "run.source.reference", 200) ? { reference: receipt.run.source.reference } : {}) },
    },
    execution: {
      ...(bounded(receipt.execution.machineId, "execution.machineId", MAX.id) ? { machineId: receipt.execution.machineId } : {}),
      ...(bounded(receipt.execution.machineName, "execution.machineName", 120) ? { machineName: receipt.execution.machineName } : {}),
      ...(receipt.execution.profile ? { profile: receipt.execution.profile } : {}), ...(receipt.execution.controller ? { controller: receipt.execution.controller } : {}),
      ...(bounded(receipt.execution.provider, "execution.provider", 80) ? { provider: receipt.execution.provider } : {}), ...(bounded(receipt.execution.region, "execution.region", 80) ? { region: receipt.execution.region } : {}),
      ...(bounded(receipt.execution.image, "execution.image", 160) ? { image: receipt.execution.image } : {}), ...(bounded(receipt.execution.agentId, "execution.agentId", 120) ? { agentId: receipt.execution.agentId } : {}),
      ...(bounded(receipt.execution.agentVersion, "execution.agentVersion", 80) ? { agentVersion: receipt.execution.agentVersion } : {}), ...(bounded(receipt.execution.modelId, "execution.modelId", 160) ? { modelId: receipt.execution.modelId } : {}),
      ...(receipt.execution.modelVersionStatus ? { modelVersionStatus: receipt.execution.modelVersionStatus } : {}),
    },
    protection: {
      requested: { ...(receipt.protection.requested.sandboxTier ? { sandboxTier: required(receipt.protection.requested.sandboxTier, "protection.requested.sandboxTier", 40) } : {}), ...(receipt.protection.requested.approvalMode ? { approvalMode: required(receipt.protection.requested.approvalMode, "protection.requested.approvalMode", 40) } : {}) },
      effective: {
        ...(receipt.protection.effective.executionProfile ? { executionProfile: required(receipt.protection.effective.executionProfile, "protection.effective.executionProfile", 40) } : {}),
        ...(receipt.protection.effective.sandboxTier ? { sandboxTier: required(receipt.protection.effective.sandboxTier, "protection.effective.sandboxTier", 40) } : {}),
        ...(receipt.protection.effective.approvalMode ? { approvalMode: required(receipt.protection.effective.approvalMode, "protection.effective.approvalMode", 40) } : {}),
        ...(receipt.protection.effective.runtimeEnforcement ? { runtimeEnforcement: required(receipt.protection.effective.runtimeEnforcement, "protection.effective.runtimeEnforcement", 120) } : {}),
        ...(receipt.protection.effective.trustModes ? { trustModes: receipt.protection.effective.trustModes.slice(0, 20).map((v, i) => required(v, `trustModes[${i}]`, 80)) } : {}),
      },
      capabilities: receipt.protection.capabilities.slice(0, 20).map((c, i) => ({ capability: required(c.capability, `capabilities[${i}].capability`, 40), evidenceClass: c.evidenceClass, ...(bounded(c.mechanism, `capabilities[${i}].mechanism`, 120) ? { mechanism: c.mechanism } : {}) })),
    },
    approvals: { requests: receipt.approvals.requests, approved: receipt.approvals.approved, denied: receipt.approvals.denied },
    changes: {
      ...(bounded(receipt.changes.branch, "changes.branch", MAX.ref) ? { branch: receipt.changes.branch } : {}), ...(bounded(receipt.changes.commit, "changes.commit", 200) ? { commit: receipt.changes.commit } : {}),
      ...(bounded(receipt.changes.pullRequest, "changes.pullRequest", MAX.ref) ? { pullRequest: receipt.changes.pullRequest } : {}), ...(bounded(receipt.changes.checkpoint, "changes.checkpoint", MAX.ref) ? { checkpoint: receipt.changes.checkpoint } : {}),
      ...(bounded(receipt.changes.artifact, "changes.artifact", MAX.ref) ? { artifact: receipt.changes.artifact } : {}),
      files: receipt.changes.files.slice(0, MAX.list).map((file, i) => ({ path: required(file.path, `changes.files[${i}].path`, MAX.ref), ...(bounded(file.op, `changes.files[${i}].op`, 20) ? { op: file.op } : {}), ...(typeof file.added === "number" ? { added: file.added } : {}), ...(typeof file.removed === "number" ? { removed: file.removed } : {}) })),
      added: receipt.changes.added,
      removed: receipt.changes.removed,
    },
    checks: receipt.checks.slice(0, MAX.checks).map((c, i) => ({ name: required(c.name, `checks[${i}].name`, 120), ...(bounded(c.commandHash, `checks[${i}].commandHash`, 128) ? { commandHash: c.commandHash } : {}), status: c.status, ...(typeof c.durationMs === "number" ? { durationMs: c.durationMs } : {}), ...(typeof c.exitCode === "number" ? { exitCode: c.exitCode } : {}) })),
    auditHealth: { correlation: receipt.auditHealth.correlation, readableStorage: receipt.auditHealth.readableStorage, successfulWrites: receipt.auditHealth.successfulWrites },
    missingEvidence: receipt.missingEvidence.slice(0, 20), observationLimitations: receipt.observationLimitations.slice(0, 20).map((l) => ({ code: l.code, message: LIMITATIONS[l.code] })),
  };
  return JSON.stringify(clean, null, 2);
}
