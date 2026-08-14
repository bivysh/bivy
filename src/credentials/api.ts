// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// The daemon credential API — Bivy's OWN model-provider auth surface (the
// "Models & providers" screen). This is the one entry every mutation flows
// through, so the CLI and PWA can't drift.
//
// Deliberately Pi-FREE: every function here operates on Bivy's own encrypted
// vault (credential-store.ts) with zero Pi involvement, so the service compiles
// and tests without Pi. The one thing that legitimately comes from Pi — the
// model-provider *catalog* (Bivy has none of its own) — is INJECTED:
// `joinProviderCatalog` takes the catalog as a parameter, and the thin
// `runtime/provider-catalog.ts` bridge supplies Pi's. See
// docs/credentials-service-plan.md §3.1.

import type { StoredCredential } from "./types.js";
import { createCredentialVault, type CredentialVerification } from "./store.js";
export type { CredentialVerification };
import {
  inferReferenceBackend,
  normalizeLabel,
  defaultSyncFor,
  DEFAULT_LABEL,
  type CredentialRecord,
  type CredentialPresets,
} from "./records.js";
import {
  loadPresets,
  loadIngestPolicy,
  defaultPresetsPath,
  setActivePreset as setActivePresetFile,
  setPresetMapping as setPresetMappingFile,
  setIngestPolicy as setIngestPolicyFile,
  type IngestPolicy,
} from "./presets.js";
import type { OAuthRefresher } from "./ports.js";

/** A model provider and whether the node currently holds a credential for it. */
export interface ProviderAuthInfo {
  id: string;
  name: string;
  /** Supports browser/subscription (OAuth) login. */
  oauth: boolean;
  /** A credential is configured (stored key, OAuth token, or env var). */
  configured: boolean;
  /** Kind of the stored credential, if any. */
  kind?: "api_key" | "oauth";
  /** Where the credential came from (stored / environment / …). */
  source?: string;
  /** Epoch ms the stored OAuth access token expires, when `kind === "oauth"`. */
  expiresAt?: number;
}

/**
 * A model provider from the catalog — the shape Bivy needs, injected so this
 * module never imports Pi. Structurally matches `pi-oauth`'s `PiProviderInfo`,
 * so the bridge can pass Pi's catalog straight through; a Bivy-owned catalog
 * later would satisfy the same shape.
 */
export interface ProviderCatalogEntry {
  id: string;
  name: string;
  oauth: boolean;
  configured: boolean;
  source?: string;
}

/**
 * Join a provider catalog with the vault's stored auth status → the "Models &
 * providers" rows. Pure w.r.t. Pi: the catalog is passed in (see
 * `runtime/provider-catalog.ts`, which supplies Pi's). The stored credential
 * `kind`/`expiresAt` come from Bivy's own vault.
 */
export async function joinProviderCatalog(
  credsDir: string,
  catalog: readonly ProviderCatalogEntry[],
): Promise<ProviderAuthInfo[]> {
  const stored = await createCredentialVault(credsDir).list();
  const infoById = new Map(stored.map((info) => [info.providerId, info]));
  return catalog.map((provider) => ({
    id: provider.id,
    name: provider.name,
    oauth: provider.oauth,
    configured: provider.configured || infoById.has(provider.id),
    kind: infoById.get(provider.id)?.type,
    source: provider.source,
    expiresAt: infoById.get(provider.id)?.expiresAt,
  }));
}

/** Export configured model-provider credentials, keyed by provider id (all local). */
export async function exportProviderAuth(credsDir: string): Promise<Record<string, StoredCredential>> {
  return createCredentialVault(credsDir).exportAll();
}

/**
 * Export only the credentials eligible for cross-node sync (`sync: "account"`) —
 * the snapshot pushed to peers. A credential the user opted to `sync: "node"`
 * stays local. Use this for the sync push; use `exportProviderAuth` for local reads.
 */
export async function exportSyncableProviderAuth(credsDir: string): Promise<Record<string, StoredCredential>> {
  return createCredentialVault(credsDir).exportSyncable();
}

/**
 * The record-shaped sync snapshot: every account-tier record keyed by
 * `provider:label`, including non-default labels and reference pointers. The v3
 * sync wire (`exportSyncableProviderAuth` is the v2 provider-keyed projection).
 */
export async function exportSyncableRecords(credsDir: string): Promise<Record<string, CredentialRecord>> {
  return createCredentialVault(credsDir).exportSyncableRecords();
}

/**
 * Browser-safe account API-key projection. Used to converge a node-less PWA's
 * E2E account vault with an enrolled node. OAuth refresh tokens, references,
 * non-default labels, and node-local records are deliberately excluded.
 */
export async function exportAccountApiKeys(credsDir: string): Promise<Array<{ provider: string; label: string; key: string; updatedAt?: number }>> {
  return (await createCredentialVault(credsDir).listRecords())
    .flatMap((record) => {
      if (record.sync !== "account" || record.source.kind !== "stored") return [];
      const credential = record.source.cred;
      return credential.type === "api_key" && typeof credential.key === "string"
        ? [{ provider: record.provider, label: record.label, key: credential.key, updatedAt: record.updatedAt }]
        : [];
    });
}

/** Record-keyed tombstones for record-shaped cross-node convergence. */
export async function exportRecordTombstones(credsDir: string): Promise<Record<string, number>> {
  return createCredentialVault(credsDir).exportRecordTombstones();
}

/**
 * Merge a record-shaped snapshot from a peer into the vault, non-destructively.
 * The wire is untyped JSON; `importRecords` (via mergeDocuments) validates each
 * record and drops anything malformed, so this is safe to call with raw input.
 */
export async function importCredentialRecords(
  credsDir: string,
  records: Record<string, unknown>,
  deletedAt: Record<string, unknown> = {},
): Promise<number> {
  const list = Object.values(records ?? {}).filter((r): r is CredentialRecord => !!r && typeof r === "object") as CredentialRecord[];
  const tombstones: Record<string, number> = {};
  for (const [key, value] of Object.entries(deletedAt ?? {})) {
    const stamp = Number(value);
    if (key && Number.isFinite(stamp) && stamp > 0) tombstones[key] = stamp;
  }
  return createCredentialVault(credsDir).importRecords(list, tombstones);
}

/** Export provider revocations for cross-node convergence. */
export async function exportProviderAuthTombstones(credsDir: string): Promise<Record<string, number>> {
  return createCredentialVault(credsDir).exportTombstones();
}

/**
 * Import a cross-node provider auth snapshot into the local vault.
 *
 * Merge, never destroy (see BivyCredentialStore.importAll): the account snapshot
 * is applied on top of the local vault rather than replacing it, and a
 * locally-fresher OAuth token is never overwritten by an older one in the
 * snapshot (rotated refresh tokens are single-use). Provider removal propagates
 * via removeProvider() re-pushing, not destructive imports.
 */
export async function importProviderAuth(
  credsDir: string,
  providers: Record<string, unknown>,
  deletedAt: Record<string, unknown> = {},
): Promise<void> {
  await createCredentialVault(credsDir).importAll(providers, deletedAt);
}

/** Store an API key for a model provider (shared by every agent via the vault). */
export async function setProviderApiKey(credsDir: string, provider: string, key: string): Promise<void> {
  const id = provider.trim().toLowerCase();
  if (!id) throw new Error("Provider is required");
  await createCredentialVault(credsDir).setApiKey(id, key);
}

/**
 * Store an api-key credential together with provider-scoped `env` (e.g. a custom
 * base URL). Used for user-provided endpoints: the base URL travels with the
 * credential so it can be injected into non-Pi agents. A `key`/`env` left
 * undefined preserves whatever the vault already holds; an empty-key credential
 * is valid (a keyless local server that still needs its base URL).
 */
export async function setProviderCredential(
  credsDir: string,
  provider: string,
  opts: { key?: string; env?: Record<string, string> },
): Promise<void> {
  const id = provider.trim().toLowerCase();
  if (!id) throw new Error("Provider is required");
  await createCredentialVault(credsDir).modify(id, async (prev) => {
    const prevApiKey = prev && prev.type === "api_key" ? prev : undefined;
    const key = (opts.key ?? prevApiKey?.key ?? "").toString();
    const env = opts.env ?? prevApiKey?.env;
    const cred: StoredCredential = { type: "api_key" };
    if (key) cred.key = key;
    if (env && Object.keys(env).length) cred.env = env;
    return cred;
  });
}

/**
 * Store a reference credential for a model provider: a pointer (`op://…` /
 * `env://NAME`) that Bivy resolves per-node at read time, so the secret stays in
 * the password manager / environment and never enters the vault. The backend is
 * inferred from the pointer's scheme. This is the recommended way to use a
 * password-manager-held model key — it supersedes wiring `ANTHROPIC_API_KEY:
 * op://…` through `cli.json`, because a reference is labeled, selectable, and
 * visible in the Models UI like any other credential.
 */
export async function setProviderReference(credsDir: string, provider: string, ref: string): Promise<void> {
  const id = provider.trim().toLowerCase();
  if (!id) throw new Error("Provider is required");
  const pointer = String(ref ?? "").trim();
  const backend = inferReferenceBackend(pointer);
  if (!backend) throw new Error("Reference must be an op://, env://, or cmd:// pointer");
  await createCredentialVault(credsDir).setReference(id, pointer, backend);
}

/** Forget a provider's stored credential (API key or OAuth token). */
export async function removeProvider(credsDir: string, provider: string): Promise<void> {
  const id = provider.trim().toLowerCase();
  if (!id) throw new Error("Provider is required");
  await createCredentialVault(credsDir).delete(id);
}

// --- multi-credential API (labeled) -----------------------------------------
// The record-addressed surface behind the Models UI: a provider can hold several
// labeled credentials (work / personal / a per-project key). The single-credential
// functions above are the label="default" special case of these.

/** Non-secret summary of one credential record — what the Models UI enumerates. */
export interface CredentialRecordSummary {
  provider: string;
  label: string;
  kind: "api_key" | "oauth" | "reference";
  sync: "account" | "node";
  origin: "bivy" | "agent-native";
  /** Epoch ms the OAuth access token expires, when `kind === "oauth"`. */
  expiresAt?: number;
  /** The non-secret pointer, when `kind === "reference"`. */
  ref?: string;
  /** Whether "Test connection" (see `testCredential`) supports this provider/kind. */
  testable: boolean;
  /** The most recent "Test connection" result for this record, if any run. */
  lastVerifiedAt?: number;
  lastVerifiedOk?: boolean;
}

/** Every stored credential as a non-secret summary (never exposes key material). */
export async function listCredentialRecords(credsDir: string): Promise<CredentialRecordSummary[]> {
  const vault = createCredentialVault(credsDir);
  const records = await vault.listRecords();
  return Promise.all(records.map(async (record): Promise<CredentialRecordSummary> => {
    const source = record.source;
    const verification = await vault.readVerification(record.provider, record.label).catch(() => undefined);
    const verified = verification ? { lastVerifiedAt: verification.at, lastVerifiedOk: verification.ok } : {};
    if (source.kind === "reference") {
      return { provider: record.provider, label: record.label, kind: "reference", sync: record.sync, origin: record.origin, ref: source.ref, testable: false, ...verified };
    }
    const cred = source.cred;
    const summary: CredentialRecordSummary = {
      provider: record.provider,
      label: record.label,
      kind: cred.type,
      sync: record.sync,
      origin: record.origin,
      testable: isTestableProvider(record.provider),
      ...verified,
    };
    if (cred.type === "oauth") summary.expiresAt = cred.expires;
    return summary;
  }));
}

/**
 * Preserve an existing record's sync/origin when re-setting it (editing the key of
 * a credential the user opted node-local must not silently re-enable sync), else
 * default to a Bivy-first, opt-out-sync credential.
 */
async function labeledMeta(credsDir: string, provider: string, label: string): Promise<Pick<CredentialRecord, "sync" | "origin">> {
  const existing = await createCredentialVault(credsDir).readRecord(provider, label);
  return { sync: existing?.sync ?? defaultSyncFor("bivy"), origin: existing?.origin ?? "bivy" };
}

/** Store an API key under a specific label (multi-account). */
export async function setProviderApiKeyLabeled(credsDir: string, provider: string, label: string, key: string): Promise<void> {
  const id = provider.trim().toLowerCase();
  if (!id) throw new Error("Provider is required");
  const apiKey = String(key ?? "").trim();
  if (!apiKey) throw new Error("API key cannot be empty");
  const meta = await labeledMeta(credsDir, id, label);
  await createCredentialVault(credsDir).putRecord({
    provider: id,
    label: normalizeLabel(label),
    source: { kind: "stored", cred: { type: "api_key", key: apiKey } },
    ...meta,
  });
}

/** Store a reference (op:// / env://) under a specific label (multi-account). */
export async function setProviderReferenceLabeled(credsDir: string, provider: string, label: string, ref: string): Promise<void> {
  const id = provider.trim().toLowerCase();
  if (!id) throw new Error("Provider is required");
  const pointer = String(ref ?? "").trim();
  const backend = inferReferenceBackend(pointer);
  if (!backend) throw new Error("Reference must be an op://, env://, or cmd:// pointer");
  const meta = await labeledMeta(credsDir, id, label);
  await createCredentialVault(credsDir).putRecord({
    provider: id,
    label: normalizeLabel(label),
    source: { kind: "reference", ref: pointer, backend },
    ...meta,
  });
}

/** Forget a single labeled credential (`provider:label`). */
export async function removeProviderCredential(credsDir: string, provider: string, label: string = DEFAULT_LABEL): Promise<void> {
  const id = provider.trim().toLowerCase();
  if (!id) throw new Error("Provider is required");
  await createCredentialVault(credsDir).deleteRecord(id, label);
}

// --- test connection ---------------------------------------------------------
// A bounded, read-only-where-possible liveness probe for one credential record.
// It NEVER sends the secret anywhere but the provider's own API, and the caller
// (the relay command in server.ts) only ever forwards the returned
// CredentialVerification back to the client — ok/at/reason, never the token.

/** A minimal authenticated GET each supported provider accepts as a liveness
 *  check — chosen for being cheap (no completion/generation billed) and not
 *  mutating anything provider-side. A provider absent here is honestly
 *  reported as `testable: false` rather than guessing at a result. */
const PROVIDER_PING: Record<string, (token: string) => { url: string; headers: Record<string, string> }> = {
  anthropic: (token) => ({ url: "https://api.anthropic.com/v1/models", headers: { "x-api-key": token, "anthropic-version": "2023-06-01" } }),
  openai: (token) => ({ url: "https://api.openai.com/v1/models", headers: { authorization: `Bearer ${token}` } }),
};

function isTestableProvider(provider: string): boolean {
  return provider.trim().toLowerCase() in PROVIDER_PING;
}

/**
 * Probe whether a stored credential actually works, and persist the result
 * (see `BivyCredentialStore.writeVerification` — node-local, never synced).
 * OAuth credentials are refreshed first via the injected `oauth` port (the
 * same refresh path the agent runtime uses), so an expired-but-refreshable
 * token counts as working; a reference credential (`op://…`) is not testable
 * here since resolving it needs the secrets port this module doesn't have.
 */
export async function testCredential(
  credsDir: string,
  provider: string,
  label: string,
  oauth: OAuthRefresher,
  fetchImpl: typeof fetch = fetch,
): Promise<CredentialVerification> {
  const vault = createCredentialVault(credsDir);
  const id = provider.trim().toLowerCase();
  const result = await probe();
  await vault.writeVerification(id, label, result).catch(() => {});
  return result;

  async function probe(): Promise<CredentialVerification> {
    const at = Date.now();
    if (!id) return { ok: false, at, reason: "not_found" };
    const record = await vault.readRecord(id, label);
    if (!record) return { ok: false, at, reason: "not_found" };
    if (record.source.kind === "reference") return { ok: false, at, reason: "not_supported" };

    const cred = record.source.cred;
    let token: string;
    if (cred.type === "oauth") {
      token = typeof cred.access === "string" ? cred.access : "";
      if (!token || (Number(cred.expires) || 0) <= Date.now() + 60_000) {
        const refreshed = await oauth.refresh(id, label).catch(() => undefined);
        if (!refreshed) return { ok: false, at, reason: "refresh_failed" };
        token = refreshed;
      }
    } else {
      token = typeof cred.key === "string" ? cred.key : "";
      if (!token) return { ok: false, at, reason: "not_found" };
    }

    const ping = PROVIDER_PING[id];
    if (!ping) return { ok: false, at, reason: "not_supported" };
    const { url, headers } = ping(token);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8_000);
      try {
        const res = await fetchImpl(url, { headers, signal: controller.signal });
        if (res.status === 401 || res.status === 403) return { ok: false, at, reason: "unauthorized" };
        return { ok: res.ok, at, ...(res.ok ? {} : { reason: "network_error" as const }) };
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      return { ok: false, at, reason: "network_error" };
    }
  }
}

// --- selection presets (config-as-code, edited from the Models UI) ----------

/** The node's current selection presets (`active` + named provider→label maps). */
export function getCredentialPresets(credsDir: string): CredentialPresets {
  return loadPresets(defaultPresetsPath(credsDir));
}

/** Set (or clear) which preset selection resolves against by default. */
export function setActiveCredentialPreset(credsDir: string, active: string | undefined): void {
  setActivePresetFile(defaultPresetsPath(credsDir), active);
}

/** Point a provider at a label within a preset (empty label clears the mapping). */
export function setCredentialPresetMapping(credsDir: string, preset: string, provider: string, label: string | undefined): void {
  setPresetMappingFile(defaultPresetsPath(credsDir), preset, provider, label);
}

/** The agent-native ingest policy (`merge`/`separate`). */
export function getCredentialIngestPolicy(credsDir: string): IngestPolicy {
  return loadIngestPolicy(defaultPresetsPath(credsDir));
}

/** Set the agent-native ingest policy. */
export function setCredentialIngestPolicy(credsDir: string, policy: IngestPolicy): void {
  setIngestPolicyFile(defaultPresetsPath(credsDir), policy);
}

/** Set a labeled credential's sync tier — the per-credential opt-out toggle. */
export async function setCredentialSync(
  credsDir: string,
  provider: string,
  label: string,
  sync: "account" | "node",
): Promise<void> {
  const id = provider.trim().toLowerCase();
  if (!id) throw new Error("Provider is required");
  const store = createCredentialVault(credsDir);
  const existing = await store.readRecord(id, label);
  if (!existing) throw new Error(`No credential for ${id}:${normalizeLabel(label)}`);
  // A cmd:// reference runs a command; syncing it would run that command on every
  // node. Keep it node-local (exportSyncableRecords also refuses to emit it).
  if (existing.source.kind === "reference" && existing.source.backend === "command" && sync === "account") {
    throw new Error("A cmd:// reference is node-local (it runs a command on this machine) and cannot be synced.");
  }
  await store.putRecord({ ...existing, sync });
}
