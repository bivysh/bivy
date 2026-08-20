// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Pure credential shapes — the domain vocabulary. No fs, no crypto, no Pi, and
// no upward imports: this file is a leaf so the storage engine, the
// document/record model, and every consumer share one definition of what a
// credential *is* without reaching up into runtime/. These types previously
// lived in runtime/credential-store.ts; moving them here removes the last
// reason the pure domain (records.ts, document.ts) pointed upward.

/** Stored api-key credential. `env` holds provider-scoped config (base URLs, ids). */
export interface ApiKeyCredential {
  type: "api_key";
  key?: string;
  env?: Record<string, string>;
  /** Store-owned mutation time used to order cross-node updates and revocations. */
  updatedAt?: number;
  [key: string]: unknown;
}

/** Stored OAuth credential. `expires` is epoch ms. */
export interface OAuthCredential {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  /**
   * Wall-clock epoch ms this token set was minted/refreshed on the node that
   * obtained it (see model-oauth `tokensFrom`). Used as the monotonic tiebreak in
   * `preferIncomingCredential` so cross-node merge follows mint order rather than
   * the access-token `expires` alone — which a fast/slow clock can inflate,
   * pinning the account onto a stale token. Optional: credentials minted before
   * this field existed fall back to the `expires` comparison.
   */
  refreshedAt?: number;
  /** Store-owned mutation time used to order cross-node updates and revocations. */
  updatedAt?: number;
  [key: string]: unknown;
}

/** One type-tagged credential per provider — Bivy's canonical shape. */
export type StoredCredential = ApiKeyCredential | OAuthCredential;

/**
 * A model-provider credential the node already holds, exposed runtime-agnostically.
 * This is the seam that lets any agent reuse a login the user did once (resolved
 * from Bivy's own credential store) instead of authenticating separately per agent.
 */
export interface ProviderCredential {
  /** Provider id the credential is for, e.g. "anthropic", "openai". */
  provider: string;
  /** Whether the token is a plain API key or an OAuth bearer (auto-refreshed). */
  kind: "api_key" | "oauth";
  /** A ready-to-use API key or OAuth access token for the provider. */
  token: string;
  /** Extra provider-scoped env (e.g. a custom base URL) to pass through. */
  env?: Record<string, string>;
}

/**
 * Node-level credential resolver shared across agents. Backed by Bivy's own
 * credential store; an adapter resolves a provider's credential and maps it to
 * whatever an agent's SDK expects (env var, header, …) so one login serves
 * every runtime.
 *
 * Named `AgentCredentialStore` to disambiguate from pi-ai's own `CredentialStore`
 * (the storage interface Bivy's store implements for injection into Pi).
 */
export interface CredentialContext {
  project?: string;
  workspace?: string;
  preferLabel?: string;
  /** A bearer rejected by the provider. OAuth resolvers refresh it immediately,
   * even when its stored expiry is still in the future; if another caller has
   * already rotated it, the newer token is returned without a second refresh. */
  rejectedToken?: string;
}

export interface AgentCredentialStore {
  /** Resolve a usable credential for a provider, optionally in a project context. */
  getCredential(provider: string, context?: CredentialContext): Promise<ProviderCredential | undefined>;
  /** Provider ids the vault currently holds a credential for (for bulk env injection). */
  listConfigured?(): Promise<string[]>;
}
