// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// The redacted provider × machine × agent readiness projection for one stored
// credential — what replaces the old boolean "Connected"/"Not connected" chip
// in Settings → Keys & OAuth. Pure and framework-agnostic like activation.ts:
// it derives display facts from real, already-known data (never fabricates an
// owner or a verification result), so it stays honest the same way the
// activation checklist does.

import type { CredentialRecordSummary } from "./protocol.js";

export type CredentialVerifiedState = "unverified" | "verified" | "failed";

export interface CredentialReadiness {
  provider: string;
  label: string;
  kind: CredentialRecordSummary["kind"];
  /** Redacted, human-readable auth owner — never a raw secret or full email. */
  ownerLabel: string;
  syncScope: "account" | "node";
  syncScopeLabel: string;
  verified: CredentialVerifiedState;
  lastVerifiedAt?: number;
  /** Whether the non-secret "Test connection" action is available for this record. */
  testable: boolean;
}

/**
 * Redact an email for display: keep up to the first two local-part characters
 * and the full domain, mask the rest — enough to recognize your own account
 * at a glance without displaying it in full. `foo@example.com` → `fo*@example.com`.
 */
export function redactEmail(email: string): string {
  const trimmed = email.trim();
  const at = trimmed.indexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return "•••";
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  const visible = local.slice(0, Math.min(2, Math.max(local.length - 1, 1)));
  const masked = "*".repeat(Math.max(local.length - visible.length, 1));
  return `${visible}${masked}@${domain}`;
}

/**
 * Project one non-secret credential summary into its redacted readiness view.
 * `accountEmail` is the signed-in Bivy account's own email (already known to
 * the client via `fetchMe`) — used ONLY to label an account-synced credential
 * as belonging to "you"; a node-only credential is never attributed to an
 * account at all, since it isn't one.
 */
export function deriveCredentialReadiness(record: CredentialRecordSummary, accountEmail?: string): CredentialReadiness {
  const syncScope = record.sync;
  const syncScopeLabel = syncScope === "account" ? "Synced to your account" : "This machine only";
  const ownerLabel = syncScope === "account" ? (accountEmail ? redactEmail(accountEmail) : "Your account") : "This machine only";
  const verified: CredentialVerifiedState = record.lastVerifiedAt == null ? "unverified" : record.lastVerifiedOk ? "verified" : "failed";
  return {
    provider: record.provider,
    label: record.label,
    kind: record.kind,
    ownerLabel,
    syncScope,
    syncScopeLabel,
    verified,
    ...(record.lastVerifiedAt != null ? { lastVerifiedAt: record.lastVerifiedAt } : {}),
    testable: record.testable,
  };
}
