// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Pure credential shapes — the domain vocabulary. No fs, no crypto, no Pi, and
// no upward imports: this file is a leaf so the storage engine, the
// document/record model, and every consumer share one definition of what a
// credential *is* without reaching up into runtime/. These types previously
// lived in runtime/credential-store.ts; moving them here removes the last
// reason the pure domain (records.ts, document.ts) pointed upward.
// See docs/internal/platform-modularization-plan.md (credentials two-layer pilot).

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
