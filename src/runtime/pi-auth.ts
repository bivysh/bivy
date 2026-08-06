// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Model-provider auth surface for the daemon (the "Models & providers" screen).
//
// Storage is Bivy's own (credential-store.ts): set / remove / export / import all
// operate directly on the encrypted vault with no Pi involvement. The one thing
// that legitimately comes from Pi is the model-provider *catalog* — the list of
// providers and their display names / OAuth capability — which the isolated
// pi-oauth bridge supplies (Bivy has no model catalog of its own).

import { createCredentialVault, type StoredCredential } from "./credential-store.js";
import { listPiProviders } from "./pi-oauth.js";

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
 * Enumerate model providers with their current auth status. The catalog + status
 * come from Pi's provider list (joined with our injected store); the stored
 * credential `kind` comes from Bivy's vault.
 */
export async function listProviders(credsDir: string, piDir: string): Promise<ProviderAuthInfo[]> {
  const [catalog, stored] = await Promise.all([listPiProviders(credsDir, piDir), createCredentialVault(credsDir).list()]);
  const infoById = new Map(stored.map((info) => [info.providerId, info]));
  return catalog.map((provider) => ({
    id: provider.id,
    name: provider.name,
    oauth: provider.oauth,
    configured: provider.configured,
    kind: infoById.get(provider.id)?.type,
    source: provider.source,
    expiresAt: infoById.get(provider.id)?.expiresAt,
  }));
}

/** Export configured model-provider credentials, keyed by provider id. */
export async function exportProviderAuth(credsDir: string): Promise<Record<string, StoredCredential>> {
  return createCredentialVault(credsDir).exportAll();
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

/** Forget a provider's stored credential (API key or OAuth token). */
export async function removeProvider(credsDir: string, provider: string): Promise<void> {
  const id = provider.trim().toLowerCase();
  if (!id) throw new Error("Provider is required");
  await createCredentialVault(credsDir).delete(id);
}
