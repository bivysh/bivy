// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Bivy's provider catalog joined with live Pi status and Bivy credentials.
// Static product metadata comes from @bivy/core; Pi is an optional freshness
// overlay rather than the authority or a prerequisite for listing providers.

import { BIVY_PROVIDER_CATALOG, bivyProvider } from "./bivy-provider-catalog.js";
import { listPiProviders } from "./pi-oauth.js";
import { joinProviderCatalog, type ProviderAuthInfo, type ProviderCatalogEntry } from "../credentials/api.js";

export type { ProviderAuthInfo };

/** Pure baseline/live merge, exported for alternate runtime bridges and tests. */
export function overlayProviderCatalog(live: readonly ProviderCatalogEntry[]): ProviderCatalogEntry[] {
  const byId = new Map<string, ProviderCatalogEntry>();
  for (const provider of BIVY_PROVIDER_CATALOG) {
    byId.set(provider.id, {
      id: provider.id,
      name: provider.name,
      oauth: provider.authMethods.some((method) => method.kind === "oauth"),
      configured: false,
    });
  }

  for (const row of live) {
    const rawId = row.id.trim().toLowerCase();
    if (!rawId) continue;
    const definition = bivyProvider(rawId);
    const id = definition?.id ?? rawId;
    const previous = byId.get(id);
    byId.set(id, {
      id,
      // Bivy owns names for registered identities; live catalogs name unknowns.
      name: definition?.name ?? (row.name || previous?.name || id),
      oauth: previous?.oauth === true || row.oauth,
      configured: previous?.configured === true || row.configured,
      // Preserve the live source/freshness signal (stored, environment, etc.).
      ...(row.source ? { source: row.source } : previous?.source ? { source: previous.source } : {}),
    });
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Enumerate Bivy's baseline providers, overlaid with Pi's live auth status. */
export async function listProviders(credsDir: string, piDir: string): Promise<ProviderAuthInfo[]> {
  const live = await listPiProviders(credsDir, piDir).catch(() => []);
  return joinProviderCatalog(credsDir, overlayProviderCatalog(live));
}
