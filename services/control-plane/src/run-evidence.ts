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
  "triggered", "routed", "claimed", "attempt_started", "checkpoint", "approval",
  "policy_denial", "retry", "fallback", "branch", "pull_request", "needs_attention",
  "completed", "cancelled",
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
      }];
    });
    if (events.length) patch.events = events;
  }

  if (input.receiptEvidence && typeof input.receiptEvidence === "object" && !Array.isArray(input.receiptEvidence)) {
    const raw = input.receiptEvidence as Record<string, unknown>;
    assertNoForbiddenKeys(raw);
    const approvals = raw.approvals && typeof raw.approvals === "object" ? raw.approvals as Record<string, unknown> : {};
    const changes = raw.fileChanges && typeof raw.fileChanges === "object" ? raw.fileChanges as Record<string, unknown> : {};
    const health = raw.auditHealth && typeof raw.auditHealth === "object" ? raw.auditHealth as Record<string, unknown> : {};
    assertNoForbiddenKeys(approvals);
    assertNoForbiddenKeys(changes);
    assertNoForbiddenKeys(health);
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
    patch.receiptEvidence = {
      approvals: { requests: count(approvals.requests), approved: count(approvals.approved), denied: count(approvals.denied) },
      fileChanges: { files, added: count(changes.added), removed: count(changes.removed) },
      auditHealth: { correlation: auditState(health.correlation), readableStorage: auditState(health.readableStorage), successfulWrites: auditState(health.successfulWrites) },
    };
  }

  return patch;
}
