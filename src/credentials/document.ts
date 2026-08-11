// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// The v3 credential-vault document: schema, migration, and merge convergence.
//
// This is the engine `credential-store.ts` will persist. It is deliberately pure
// and I/O-free (it imports only the record model), so every migration and
// convergence rule is unit-testable without a vault, crypto, or the filesystem —
// which matters because the vault's fs/crypto glue is auth-critical and must not
// be edited on faith.
//
// v3 stores a CredentialRecord per NATURAL key `provider:label` (see records.ts),
// replacing v2's one-`StoredCredential`-per-provider map. The merge rules are the
// v2 rules (see credential-store.ts history) re-keyed to operate per record:
// merge-never-destroy, freshest-OAuth-wins, rotation-safe, tombstone-newer-wins.
//
// See docs/credentials-service-plan.md §3.2 / §8.

import type { StoredCredential, OAuthCredential } from "../runtime/credential-store.js";
import {
  credKey,
  normalizeProvider,
  normalizeLabel,
  DEFAULT_LABEL,
  type CredentialRecord,
} from "./records.js";

/** The on-disk document. `credentials`/`deletedAt` are keyed by `provider:label`. */
export interface CredentialVaultDocumentV3 {
  v: 3;
  credentials: Record<string, CredentialRecord>;
  deletedAt: Record<string, number>;
}

/** An empty v3 document — the "nothing stored yet" value. */
export function emptyDocument(): CredentialVaultDocumentV3 {
  return { v: 3, credentials: {}, deletedAt: {} };
}

function isStoredCredential(value: unknown): value is StoredCredential {
  if (!value || typeof value !== "object") return false;
  const type = (value as { type?: unknown }).type;
  return type === "api_key" || type === "oauth";
}

function isCredentialRecord(value: unknown): value is CredentialRecord {
  if (!value || typeof value !== "object") return false;
  const r = value as Partial<CredentialRecord>;
  if (typeof r.provider !== "string" || typeof r.label !== "string") return false;
  if (r.sync !== "account" && r.sync !== "node") return false;
  if (r.origin !== "bivy" && r.origin !== "agent-native") return false;
  const src = r.source as { kind?: unknown; cred?: unknown; ref?: unknown } | undefined;
  if (!src || typeof src !== "object") return false;
  if (src.kind === "stored") return isStoredCredential(src.cred);
  if (src.kind === "reference") return typeof src.ref === "string" && !!src.ref;
  return false;
}

/** Wrap a bare v2 `StoredCredential` as a v3 record under `provider:default`. */
export function recordFromStored(provider: string, cred: StoredCredential): CredentialRecord {
  // The store-owned `updatedAt` becomes authoritative on the RECORD; strip it out
  // of the stored cred so content-comparison during merge isn't tripped by a stale
  // embedded stamp. `refreshedAt` (OAuth) is credential content, not store metadata —
  // it stays on the cred.
  const { updatedAt: embeddedUpdatedAt, ...cleanCred } = cred as StoredCredential & { updatedAt?: unknown };
  const record: CredentialRecord = {
    provider: normalizeProvider(provider),
    label: DEFAULT_LABEL,
    source: { kind: "stored", cred: cleanCred as StoredCredential },
    // Migrated Bivy-vault credentials default to the opt-out account-sync tier;
    // origin is unknown at migration time, so attribute them to Bivy (they lived
    // in Bivy's vault). origin never branches behavior — it only picks this default.
    sync: "account",
    origin: "bivy",
  };
  const updatedAt = Number(embeddedUpdatedAt);
  if (Number.isFinite(updatedAt) && updatedAt > 0) record.updatedAt = updatedAt;
  return record;
}

/** The OAuth credential inside a record, when it is a stored OAuth token set. */
function oauthOf(record: CredentialRecord | undefined): OAuthCredential | undefined {
  if (!record || record.source.kind !== "stored") return undefined;
  return record.source.cred.type === "oauth" ? (record.source.cred as OAuthCredential) : undefined;
}

/** Deep content compare that ignores the store-owned `updatedAt` stamp. */
function sameRecordContent(a: CredentialRecord | undefined, b: CredentialRecord): boolean {
  if (!a) return false;
  const strip = ({ updatedAt: _drop, ...rest }: CredentialRecord) => rest;
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}

/**
 * Should `incoming` replace `local` during a non-destructive merge? The v2 rule,
 * re-keyed to records:
 *  - No local → take incoming.
 *  - Only stored-OAuth-vs-stored-OAuth needs freshness arbitration; anything else
 *    (api-key, reference, a type/source switch) lets a real content change win.
 *  - A snapshot with a blank refresh token must never clobber a usable one
 *    (rotated refresh tokens are single-use).
 *  - Prefer the token minted LATER by `refreshedAt`; else the later `expires`. A
 *    tie KEEPS local (strictly-greater wins), so equal stamps can't churn/rotate.
 */
export function preferIncomingRecord(local: CredentialRecord | undefined, incoming: CredentialRecord): boolean {
  if (!local) return true;
  const localOauth = oauthOf(local);
  const incomingOauth = oauthOf(incoming);
  if (!localOauth || !incomingOauth) return true;
  const localRefresh = String(localOauth.refresh ?? "").trim();
  const incomingRefresh = String(incomingOauth.refresh ?? "").trim();
  if (!incomingRefresh && localRefresh) return false;
  const lt = Number(localOauth.refreshedAt);
  const it = Number(incomingOauth.refreshedAt);
  if (Number.isFinite(lt) && Number.isFinite(it)) return it > lt;
  return (Number(incomingOauth.expires) || 0) > (Number(localOauth.expires) || 0);
}

/** A tombstone wins only when it is newer than the record it would remove. */
export function tombstoneWinsRecord(record: CredentialRecord | undefined, deletedAt: number): boolean {
  if (!Number.isFinite(deletedAt) || deletedAt <= 0) return false;
  if (!record) return true;
  const updatedAt = Number(record.updatedAt);
  const refreshedAt = Number(oauthOf(record)?.refreshedAt);
  const recordTime = Number.isFinite(updatedAt) && updatedAt > 0
    ? updatedAt
    : Number.isFinite(refreshedAt) && refreshedAt > 0 ? refreshedAt : 0;
  return deletedAt > recordTime;
}

/** Coerce a parsed `{ [key]: CredentialRecord }` map, normalizing/validating keys. */
function normalizeRecordMap(parsed: unknown): Record<string, CredentialRecord> {
  const out: Record<string, CredentialRecord> = {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;
  for (const [, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isCredentialRecord(value)) continue;
    const record: CredentialRecord = {
      ...value,
      provider: normalizeProvider(value.provider),
      label: normalizeLabel(value.label),
    };
    out[credKey(record.provider, record.label)] = record;
  }
  return out;
}

/** Coerce a v2/v1 `{ [providerId]: StoredCredential }` map into v3 records. */
function providerMapToRecords(parsed: unknown): Record<string, CredentialRecord> {
  const out: Record<string, CredentialRecord> = {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isStoredCredential(value)) continue;
    const record = recordFromStored(id, value);
    out[credKey(record.provider, record.label)] = record;
  }
  return out;
}

function normalizeTombstones(parsed: unknown, keyMap?: (k: string) => string): Record<string, number> {
  const out: Record<string, number> = {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;
  for (const [rawKey, value] of Object.entries(parsed as Record<string, unknown>)) {
    const stamp = Number(value);
    if (!Number.isFinite(stamp) || stamp <= 0) continue;
    const key = keyMap ? keyMap(rawKey) : rawKey;
    if (key) out[key] = Math.max(out[key] ?? 0, stamp);
  }
  return out;
}

/**
 * Migrate any prior parsed vault JSON into a v3 document:
 *  - v3 (`{ v:3, credentials, deletedAt }`) → normalized as-is.
 *  - v2 (`{ v:2, providers, deletedAt }`)   → each provider becomes `provider:default`.
 *  - v1 (bare `{ [providerId]: StoredCredential }`) → same, no tombstones.
 * Unknown/garbage → an empty document (every caller already handles "no credential").
 */
export function migrateToV3(parsed: unknown): CredentialVaultDocumentV3 {
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const doc = parsed as { v?: unknown; credentials?: unknown; providers?: unknown; deletedAt?: unknown };
    if (doc.v === 3) {
      return {
        v: 3,
        credentials: normalizeRecordMap(doc.credentials),
        deletedAt: normalizeTombstones(doc.deletedAt),
      };
    }
    if (doc.v === 2) {
      return {
        v: 3,
        credentials: providerMapToRecords(doc.providers),
        deletedAt: normalizeTombstones(doc.deletedAt, (id) => credKey(id, DEFAULT_LABEL)),
      };
    }
  }
  // v1 legacy: a bare provider→StoredCredential map (or nothing usable).
  return { v: 3, credentials: providerMapToRecords(parsed), deletedAt: {} };
}

/** The result of merging a snapshot into a local document. */
export interface MergeResult {
  document: CredentialVaultDocumentV3;
  imported: number;
  changed: boolean;
}

/**
 * Merge an incoming record snapshot (and its tombstones) into `local`, non-
 * destructively — the v2 `importAll` rules, re-keyed to records:
 *  - A tombstone newer than an incoming record drops it.
 *  - Identical content is a no-op (no churn / re-encrypt).
 *  - A lagging or refresh-less snapshot never overwrites a fresher local login.
 *  - A later re-login makes an older tombstone obsolete.
 * Pure: returns a new document; never mutates `local`.
 */
export function mergeDocuments(
  local: CredentialVaultDocumentV3,
  incomingCredentials: Record<string, CredentialRecord>,
  incomingDeletedAt: Record<string, number> = {},
): MergeResult {
  const credentials: Record<string, CredentialRecord> = { ...local.credentials };
  const deletedAt: Record<string, number> = { ...local.deletedAt };
  let imported = 0;
  let changed = false;

  for (const incoming of Object.values(normalizeRecordMap(incomingCredentials))) {
    // NEVER accept a `cmd://` reference from a merge/sync snapshot: it runs a
    // command, so a malicious enrolled peer could otherwise inject one that
    // executes on this node (cross-node code execution). Command references are
    // only ever created locally (setReference writes directly, not via merge).
    if (incoming.source.kind === "reference" && incoming.source.backend === "command") continue;
    const key = credKey(incoming.provider, incoming.label);
    if (tombstoneWinsRecord(incoming, deletedAt[key] ?? 0)) continue;
    const localRecord = credentials[key];
    if (sameRecordContent(localRecord, incoming)) continue;
    if (!preferIncomingRecord(localRecord, incoming)) continue;
    if (!(key in credentials)) imported += 1;
    credentials[key] = incoming;
    const incomingUpdatedAt = Number(incoming.updatedAt);
    if (!Number.isFinite(deletedAt[key]) || incomingUpdatedAt > deletedAt[key]) delete deletedAt[key];
    changed = true;
  }

  for (const [rawKey, rawStamp] of Object.entries(incomingDeletedAt ?? {})) {
    const key = String(rawKey ?? "");
    const stamp = Number(rawStamp);
    if (!key || !Number.isFinite(stamp) || stamp <= 0) continue;
    if ((deletedAt[key] ?? 0) >= stamp) continue;
    // A later re-login makes an older tombstone obsolete; don't retain it.
    if (credentials[key] && !tombstoneWinsRecord(credentials[key], stamp)) continue;
    deletedAt[key] = stamp;
    if (tombstoneWinsRecord(credentials[key], stamp)) delete credentials[key];
    changed = true;
  }

  return { document: { v: 3, credentials, deletedAt }, imported, changed };
}
