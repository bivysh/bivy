// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Pi model-catalog bridge.
//
// Bivy owns credentials end-to-end: storage (credential-store.ts) and OAuth
// login/refresh (oauth/model-oauth.ts). The one thing that legitimately remains
// Pi's is the model/provider CATALOG — the list of providers and their models —
// because Bivy has no model catalog of its own. That is model metadata, not a
// credential, and it is isolated here. Pi never performs a credential operation
// for Bivy; it only enumerates models and (as an agent) reads through the store.

import path from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { CredentialStore } from "@earendil-works/pi-ai";
import { BivyCredentialStore, createCredentialVault } from "./credential-store.js";
import { isNativeOAuthProvider } from "./oauth/model-oauth-providers.js";

/** Provider catalog entry: model metadata Pi owns, joined with Bivy auth state. */
export interface PiProviderInfo {
  id: string;
  name: string;
  /** Supports browser/subscription (OAuth) login — per Bivy's native registry. */
  oauth: boolean;
  /** A credential is configured (stored key, OAuth token, or ambient env var). */
  configured: boolean;
  /** Where the resolved credential comes from (stored / environment / …). */
  source?: string;
}

/** Adapt Bivy's store to pi-ai's structurally-identical CredentialStore for injection. */
export function piCredentialStore(store: BivyCredentialStore): CredentialStore {
  return store as unknown as CredentialStore;
}

/**
 * Build a Pi ModelRuntime backed by Bivy's credential store. Credentials come
 * from the node's shared vault (`credsDir`); the model catalog cache
 * (`models.json`) lives in Pi's own dir (`piDir`). `allowModelNetwork` defaults
 * to false for the catalog paths (fast, offline); the pi *session* runtime
 * (pi.ts) allows network so dynamic model lists load.
 */
export async function createPiModelRuntime(
  opts: { credsDir: string; piDir: string; allowModelNetwork?: boolean; store?: BivyCredentialStore },
): Promise<ModelRuntime> {
  const store = opts.store ?? createCredentialVault(opts.credsDir);
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  return ModelRuntime.create({
    credentials: piCredentialStore(store),
    modelsPath: path.join(opts.piDir, "models.json"),
    allowModelNetwork: opts.allowModelNetwork ?? false,
  });
}

/** Enumerate the model-provider catalog with each provider's current auth status. */
export async function listPiProviders(credsDir: string, piDir: string): Promise<PiProviderInfo[]> {
  const runtime = await createPiModelRuntime({ credsDir, piDir });
  return runtime
    .getProviders()
    .map((provider) => {
      const status = runtime.getProviderAuthStatus(provider.id);
      return {
        id: provider.id,
        name: provider.name,
        // Whether we offer a subscription login is decided by Bivy's own OAuth
        // registry, not Pi's provider metadata.
        oauth: isNativeOAuthProvider(provider.id),
        configured: status.configured,
        source: status.source,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
