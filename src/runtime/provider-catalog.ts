// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// The Pi-catalog bridge: the single place the credential API's provider listing
// is joined with Pi's model-provider catalog.
//
// The credential API (src/credentials/api.ts) is deliberately Pi-free and takes
// the catalog as data (`joinProviderCatalog`). This thin module is the injection
// point — it fetches Pi's catalog and hands it in. Swapping Pi for a Bivy-owned
// catalog later is a change here and nowhere else.

import { BIVY_PROVIDER_CATALOG } from "./bivy-provider-catalog.js";
import { listPiProviders } from "./pi-oauth.js";
import { joinProviderCatalog, type ProviderAuthInfo, type ProviderCatalogEntry } from "../credentials/api.js";

export type { ProviderAuthInfo };

/** Enumerate Bivy's authoritative providers, overlaid with Pi's live status. */
export async function listProviders(credsDir: string, piDir: string): Promise<ProviderAuthInfo[]> {
  const byId = new Map<string, ProviderCatalogEntry>();
  for (const provider of BIVY_PROVIDER_CATALOG) byId.set(provider.id, {
    id: provider.id,
    name: provider.name,
    oauth: provider.authMethods.some((method) => method.kind === "oauth"),
    configured: false,
  });
  for (const provider of await listPiProviders(credsDir, piDir).catch(() => [])) byId.set(provider.id, provider);
  return joinProviderCatalog(credsDir, [...byId.values()].sort((a, b) => a.name.localeCompare(b.name)));
}
