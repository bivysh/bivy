// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Injected capability ports for the node credential service. These abstract the
// three dependencies the vault (credential-store.ts) and resolver
// (credentials.ts) currently import *upward* — authenticated crypto, reference
// resolution, and OAuth refresh — so that when those engines move into this
// layer (pilot steps 3-4, see docs/internal/platform-modularization-plan.md)
// they depend on these contracts instead of runtime/, secrets.ts, and e2e.ts.
//
// The provider catalog is already inverted (joinProviderCatalog in api.ts, with
// runtime/provider-catalog.ts as the consumer-side Pi bridge), so it is not
// re-declared here. Concrete adapters for these ports live on the *consumer*
// side and are wired in step 3 where the service is constructed.
//
// Pure leaf: no imports. `Buffer` is a Node global type.

/**
 * Authenticated symmetric crypto for the at-rest vault (AES-256-GCM).
 * Mirrors `seal`/`open` in src/e2e.ts; the node adapter is `{ seal, open }`.
 * The key is passed per call — the store owns key minting/loading.
 */
export interface Sealer {
  seal(key: Buffer, plaintext: string): string;
  open(key: Buffer, payload: string): string;
}

/**
 * Resolves a password-manager / env reference (`op://…`, `env://…`, `cmd://…`)
 * to a plaintext secret, or `undefined` if it cannot be resolved. The node
 * adapter binds the data dir (`resolveSecret(ref, appDir)`).
 */
export interface SecretResolver {
  resolve(ref: string): Promise<string | undefined>;
}

/**
 * Refreshes the OAuth token set for the selected provider account (`label`) and
 * returns the new access token, or `undefined` if refresh is unavailable. The
 * node adapter binds the creds dir (`refreshModelOAuth(credsDir, provider, label)`).
 */
export interface OAuthRefresher {
  refresh(providerId: string, label: string): Promise<string | undefined>;
}
