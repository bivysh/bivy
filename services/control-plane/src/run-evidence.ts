// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import type { RunEvidenceEvent, RunEvidenceEventKind, RunCheck, RunEvidencePatch, RunReceiptEvidence } from "./store.js";

// Issue #153: turn an untrusted node report into the only shape the control
// plane will ever persist for a run's evidence trail. Anything that looks like
// a prompt, transcript, diff, file content, secret, token, or raw command/tool
// output is rejected outright (not silently dropped) so a misbehaving/legacy
// node fails loudly during development rather than quietly leaking data later.
const FORBIDDEN = /prompt|transcript|content|diff|secret|token|command|output|stdout|stderr|tool/i;
const EVENT_KINDS = new Set<RunEvidenceEventKind>([
  "trigger_received", "trigger_matched", "queued", "routed", "provisioning", "claimed",
  "agent_started", "checks_started", "checks_completed", "result_delivery", "notification",
  "retry", "cancel_requested", "terminal",
  "triggered", "attempt_started", "checkpoint", "approval", "policy_denial", "fallback",
  "branch", "pull_request", "needs_attention", "completed", "cancelled",
]);
const CHECK_STATUSES = new Set(["passed", "failed", "skipped"]);
const EVENT_STATUSES = new Set(["passed", "failed", "denied", "approved"]);
// Only these output fields are ever accepted — a plain allowlist, not just the
// FORBIDDEN regex, so a benignly-named-but-wrong key (e.g. "log") is dropped
// rather than silently stored.
const OUTPUT_FIELDS = ["sessionId", "branch", "prUrl", "artifactUrl", "failure", "checkpoint", "commit"] as const;

const text = (value: unknown, max = 240): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;

/** `exempt` lets one specific, intentionally-named container key through the
 *  substring check (e.g. the top-level "output" field, or a check's
 *  "commandHash" — a hash, not a command) — every OTHER key is still checked. */
function assertNoForbiddenKeys(obj: Record<string, unknown>, exempt?: string): void {
  if (Object.keys(obj).some((key) => key !== exempt && FORBIDDEN.test(key))) {
    throw new Error("sensitive evidence field rejected");
  }
}

/** Validate + bound a single node-reported evidence patch. Throws on anything
 *  that looks sensitive; silently drops/caps anything merely malformed. */
export function sanitizeEvidencePatch(value: unknown): RunEvidencePatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  // "output" is our own allowlisted container key — its CONTENTS are validated
  // separately below via the OUTPUT_FIELDS allowlist, so the substring check
  // only needs to skip the literal key name (which would otherwise always
  // self-match the "output" pattern).
  assertNoForbiddenKeys(input, "output");
  const patch: RunEvidencePatch = {};

  const routingReason = text(input.routingReason, 200);
  if (routingReason) patch.routingReason = routingReason;

  if (input.output && typeof input.output === "object" && !Array.isArray(input.output)) {
    const rawOutput = input.output as Record<string, unknown>;
    assertNoForbiddenKeys(rawOutput);
    const output: RunEvidencePatch["output"] = {};
    for (const field of OUTPUT_FIELDS) {
      const bounded = text(rawOutput[field], field === "failure" ? 400 : 500);
      if (bounded) output[field] = bounded;
    }
    if (Object.keys(output).length) patch.output = output;
  }

  if (Array.isArray(input.checks)) {
    const checks = input.checks.slice(0, 50).flatMap((raw): RunCheck[] => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
      const check = raw as Record<string, unknown>;
      // commandHash is a hash, not a command — explicitly exempt from the
      // FORBIDDEN "command" substring match.
      assertNoForbiddenKeys(check, "commandHash");
      const name = text(check.name, 120);
      const status = String(check.status);
      if (!name || !CHECK_STATUSES.has(status)) return [];
      return [{
        name,
        commandHash: text(check.commandHash, 128),
        status: status as RunCheck["status"],
        exitCode: typeof check.exitCode === "number" ? Math.trunc(check.exitCode) : undefined,
        durationMs: typeof check.durationMs === "number" ? Math.max(0, Math.min(30 * 60 * 1000, Math.trunc(check.durationMs))) : undefined,
      }];
    });
    if (checks.length) patch.checks = checks;
  }

  if (Array.isArray(input.events)) {
    const events = input.events.slice(-100).flatMap((raw): RunEvidenceEvent[] => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
      const event = raw as Record<string, unknown>;
      assertNoForbiddenKeys(event);
      if (typeof event.kind !== "string" || !EVENT_KINDS.has(event.kind as RunEvidenceEventKind)) return [];
      const status = event.status !== undefined ? String(event.status) : undefined;
      return [{
        at: text(event.at, 40) ?? new Date().toISOString(),
        kind: event.kind as RunEvidenceEventKind,
        summary: text(event.summary) ?? "Run state changed.",
        attempt: typeof event.attempt === "number" ? Math.max(1, Math.min(100, Math.trunc(event.attempt))) : undefined,
        ref: text(event.ref, 200),
        url: text(event.url, 500),
        status: status && EVENT_STATUSES.has(status) ? (status as RunEvidenceEvent["status"]) : undefined,
        reasonCode: text(event.reasonCode, 80),
        evidenceRef: text(event.evidenceRef, 500),
        milestoneId: text(event.milestoneId, 120),
      }];
    });
    if (events.length) patch.events = events;
  }

  if (input.usage && typeof input.usage === "object" && !Array.isArray(input.usage)) {
    const raw = input.usage as Record<string, unknown>;
    // Token COUNTS are allowlisted aggregate usage, never token strings. Reject
    // any other sensitive-looking key while benign unknown keys are dropped.
    const usageFields = new Set(["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "costUsd"]);
    if (Object.keys(raw).some((key) => !usageFields.has(key) && FORBIDDEN.test(key))) throw new Error("sensitive evidence field rejected");
    const count = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value)
      ? Math.max(0, Math.min(1_000_000_000, Math.trunc(value))) : undefined;
    const costUsd = typeof raw.costUsd === "number" && Number.isFinite(raw.costUsd)
      ? Math.max(0, Math.min(1_000_000, Math.round(raw.costUsd * 1_000_000) / 1_000_000)) : undefined;
    patch.usage = {
      inputTokens: count(raw.inputTokens), outputTokens: count(raw.outputTokens),
      cacheReadTokens: count(raw.cacheReadTokens), cacheWriteTokens: count(raw.cacheWriteTokens), costUsd,
    };
  }

  if (input.notification && typeof input.notification === "object" && !Array.isArray(input.notification)) {
    const raw = input.notification as Record<string, unknown>;
    assertNoForbiddenKeys(raw);
    const status = ["not_requested", "pending", "delivered", "failed"].includes(String(raw.status))
      ? String(raw.status) as NonNullable<RunEvidencePatch["notification"]>["status"] : undefined;
    const channel = ["push", "email", "webhook"].includes(String(raw.channel))
      ? String(raw.channel) as NonNullable<RunEvidencePatch["notification"]>["channel"] : undefined;
    if (status) patch.notification = { status, channel, updatedAt: text(raw.updatedAt, 40) ?? new Date().toISOString(), reason: text(raw.reason, 200) };
  }

  if (Array.isArray(input.references)) {
    const refs = input.references.slice(0, 20).flatMap((value): NonNullable<RunEvidencePatch["references"]> => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const raw = value as Record<string, unknown>;
      assertNoForbiddenKeys(raw);
      const kind = ["receipt", "evidence", "log"].includes(String(raw.kind)) ? String(raw.kind) as "receipt" | "evidence" | "log" : undefined;
      const ref = text(raw.ref, 500);
      return kind && ref ? [{ kind, ref, url: text(raw.url, 500) }] : [];
    });
    if (refs.length) patch.references = refs;
  }

  if (input.attention === null) patch.attention = null;
  else if (input.attention && typeof input.attention === "object" && !Array.isArray(input.attention)) {
    const raw = input.attention as Record<string, unknown>;
    assertNoForbiddenKeys(raw);
    const severity = ["warning", "error", "critical"].includes(String(raw.severity))
      ? String(raw.severity) as "warning" | "error" | "critical" : undefined;
    const reason = text(raw.reason, 240);
    if (severity && reason) patch.attention = { severity, reason, since: text(raw.since, 40) ?? new Date().toISOString() };
  }

  if (input.receiptEvidence && typeof input.receiptEvidence === "object" && !Array.isArray(input.receiptEvidence)) {
    const raw = input.receiptEvidence as Record<string, unknown>;
    assertNoForbiddenKeys(raw);
    const approvals = raw.approvals && typeof raw.approvals === "object" ? raw.approvals as Record<string, unknown> : {};
    const changes = raw.fileChanges && typeof raw.fileChanges === "object" ? raw.fileChanges as Record<string, unknown> : {};
    const health = raw.auditHealth && typeof raw.auditHealth === "object" ? raw.auditHealth as Record<string, unknown> : {};
    const execution = raw.execution && typeof raw.execution === "object" ? raw.execution as Record<string, unknown> : {};
    const protection = raw.protection && typeof raw.protection === "object" ? raw.protection as Record<string, unknown> : {};
    const effective = protection.effective && typeof protection.effective === "object" ? protection.effective as Record<string, unknown> : {};
    assertNoForbiddenKeys(approvals);
    assertNoForbiddenKeys(changes);
    assertNoForbiddenKeys(health);
    assertNoForbiddenKeys(execution);
    assertNoForbiddenKeys(protection);
    assertNoForbiddenKeys(effective);
    const count = (value: unknown) => typeof value === "number" ? Math.max(0, Math.min(1_000_000, Math.trunc(value))) : 0;
    const auditState = (value: unknown): "healthy" | "missing" => value === "healthy" ? "healthy" : "missing";
    const files = Array.isArray(changes.files) ? changes.files.slice(0, 100).flatMap((value): RunReceiptEvidence["fileChanges"]["files"] => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const file = value as Record<string, unknown>;
      assertNoForbiddenKeys(file);
      const path = text(file.path, 500);
      if (!path) return [];
      return [{ path, ...(text(file.op, 20) ? { op: text(file.op, 20) } : {}), added: count(file.added), removed: count(file.removed) }];
    }) : [];
    const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined => allowed.includes(value as T) ? value as T : undefined;
    const profile = oneOf(execution.profile, ["trusted_workstation", "isolated_customer_cloud", "restricted"] as const);
    const controller = oneOf(execution.controller, ["customer", "bivy_hosted_provisioning"] as const);
    const modelVersionStatus = oneOf(execution.modelVersionStatus, ["available", "unavailable", "unknown"] as const);
    const executionEvidence: RunReceiptEvidence["execution"] = {
      ...(profile ? { profile } : {}), ...(controller ? { controller } : {}),
      ...(text(execution.agentVersion, 80) ? { agentVersion: text(execution.agentVersion, 80) } : {}),
      ...(modelVersionStatus ? { modelVersionStatus } : {}),
    };
    const executionProfile = oneOf(effective.executionProfile, ["trusted_workstation", "isolated_customer_cloud", "restricted"] as const);
    const sandboxTier = oneOf(effective.sandboxTier, ["read-only", "workspace-write", "danger-full-access"] as const);
    const approvalMode = oneOf(effective.approvalMode, ["never", "risky", "always", "autonomous"] as const);
    const capabilityNames = ["sandbox", "approval", "tool", "network", "credential_custody", "runtime_policy"] as const;
    const evidenceClasses = ["enforced", "observed", "unavailable"] as const;
    type ProtectionCapability = NonNullable<NonNullable<RunReceiptEvidence["protection"]>["capabilities"]>[number];
    const capabilities: ProtectionCapability[] = Array.isArray(protection.capabilities) ? protection.capabilities.slice(0, 20).flatMap((value): ProtectionCapability[] => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const capability = value as Record<string, unknown>;
      assertNoForbiddenKeys(capability);
      const name = oneOf(capability.capability, capabilityNames);
      const evidenceClass = oneOf(capability.evidenceClass, evidenceClasses);
      if (!name || !evidenceClass) return [];
      return [{ capability: name, evidenceClass, ...(text(capability.mechanism, 120) ? { mechanism: text(capability.mechanism, 120) } : {}) }];
    }) : [];
    patch.receiptEvidence = {
      approvals: { requests: count(approvals.requests), approved: count(approvals.approved), denied: count(approvals.denied) },
      fileChanges: { files, added: count(changes.added), removed: count(changes.removed) },
      auditHealth: { correlation: auditState(health.correlation), readableStorage: auditState(health.readableStorage), successfulWrites: auditState(health.successfulWrites) },
      ...(Object.keys(executionEvidence).length ? { execution: executionEvidence } : {}),
      ...((executionProfile || sandboxTier || approvalMode || text(effective.runtimeEnforcement, 120) || capabilities.length) ? { protection: {
        effective: {
          ...(executionProfile ? { executionProfile } : {}), ...(sandboxTier ? { sandboxTier } : {}), ...(approvalMode ? { approvalMode } : {}),
          ...(text(effective.runtimeEnforcement, 120) ? { runtimeEnforcement: text(effective.runtimeEnforcement, 120) } : {}),
          ...(Array.isArray(effective.trustModes) ? { trustModes: effective.trustModes.slice(0, 20).flatMap((value) => text(value, 80) ? [text(value, 80)!] : []) } : {}),
        },
        capabilities,
      } } : {}),
    };
  }

  return patch;
}
