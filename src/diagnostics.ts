// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Redacted diagnostics export + privacy-safe activation instrumentation (B4d).
//
// A support bundle a user can share without leaking secrets, prompts, transcripts,
// diffs, or repo contents: versions, health counters, a whitelisted set of config
// flags (values still passed through redactSecrets defensively), and the activation
// stage record. Everything user-authored stays on the node.

import { redactSecrets } from "./redact.js";

/** Ordered activation stages — the golden path from install to first useful task. */
export const ACTIVATION_STAGES = ["install", "node_online", "runtime", "credential", "repo", "first_task"] as const;
export type ActivationStage = (typeof ACTIVATION_STAGES)[number];
export type ActivationStatus = "ok" | "blocked" | "skipped" | "pending";

export interface ActivationRecord {
  stage: ActivationStage;
  status: ActivationStatus;
  /** A bounded, non-sensitive reason for a blocked/skipped stage (redacted). */
  note?: string;
}

/**
 * Map the setup/doctor readiness booleans to a privacy-safe activation record —
 * where the golden path is blocked, and where it flowed. No content, only the
 * stage and its status. `null` for an unknown stage means "pending" (not reached).
 */
export function activationRecord(readiness: {
  nodeOnline?: boolean;
  runtimeReady?: boolean;
  credentialReady?: boolean | null; // null = agent-managed / not applicable
  repoChosen?: boolean;
  firstTaskReady?: boolean;
}): ActivationRecord[] {
  const status = (ok: boolean | null | undefined, skipWhenNull = false): ActivationStatus => {
    if (ok === null || ok === undefined) return skipWhenNull ? "skipped" : "pending";
    return ok ? "ok" : "blocked";
  };
  return [
    { stage: "install", status: "ok" }, // reaching this code means the CLI installed
    { stage: "node_online", status: status(readiness.nodeOnline) },
    { stage: "runtime", status: status(readiness.runtimeReady) },
    { stage: "credential", status: status(readiness.credentialReady, true) },
    { stage: "repo", status: status(readiness.repoChosen) },
    { stage: "first_task", status: status(readiness.firstTaskReady) },
  ];
}

/** Env vars safe to include in a diagnostics bundle: non-secret config knobs only.
 *  Anything not matching is dropped entirely (not just redacted). */
const SAFE_ENV_KEYS = new Set([
  "BIVY_APPROVAL_MODE", "BIVY_SANDBOX", "BIVY_RUNTIME", "BIVY_MULTI_USER_HOST",
  "BIVY_REQUIRE_LOCAL_AUTH", "BIVY_TURN_TIMEOUT_MS", "BIVY_AUTOMATION_CHECKS",
  "PORT", "BIVY_PUBLIC_URL",
]);

export interface DiagnosticsInput {
  version?: string;
  platform?: string;
  nodeVersion?: string;
  relayConfigured?: boolean;
  /** Health counters only — no session content. */
  health?: Record<string, unknown>;
  env?: Record<string, string | undefined>;
  activation?: ActivationRecord[];
  generatedAt?: string;
}

export interface DiagnosticsReport {
  version: string;
  platform: string;
  nodeVersion: string;
  relayConfigured: boolean;
  health: Record<string, unknown>;
  config: Record<string, string>;
  activation: ActivationRecord[];
  generatedAt: string;
}

/** Deep-redact any string leaf in a JSON-ish value. */
function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redactSecrets(value) as unknown as T;
  if (Array.isArray(value)) return value.map(redactDeep) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v);
    return out as T;
  }
  return value;
}

/**
 * Assemble a shareable diagnostics report. Only whitelisted config keys are
 * included; every string leaf is passed through redactSecrets as a backstop so a
 * value that slips in (a URL with an embedded token, say) is still masked.
 */
export function buildDiagnosticsReport(input: DiagnosticsInput): DiagnosticsReport {
  const config: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.env ?? {})) {
    if (SAFE_ENV_KEYS.has(k) && typeof v === "string" && v.length) config[k] = redactSecrets(v);
  }
  return {
    version: input.version ?? "unknown",
    platform: input.platform ?? "unknown",
    nodeVersion: input.nodeVersion ?? "unknown",
    relayConfigured: Boolean(input.relayConfigured),
    health: redactDeep(input.health ?? {}),
    config,
    activation: input.activation ?? [],
    generatedAt: input.generatedAt ?? "",
  };
}
