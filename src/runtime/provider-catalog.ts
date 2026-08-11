// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// The Pi-catalog bridge: the single place the credential API's provider listing
// is joined with Pi's model-provider catalog.
//
// The credential API (src/credentials/api.ts) is deliberately Pi-free and takes
// the catalog as data (`joinProviderCatalog`). This thin module is the injection
// point — it fetches Pi's catalog and hands it in. Swapping Pi for a Bivy-owned
// catalog later is a change here and nowhere else.

import { listPiProviders } from "./pi-oauth.js";
import { joinProviderCatalog, type ProviderAuthInfo } from "../credentials/api.js";

export type { ProviderAuthInfo };

/** Enumerate model providers with their current auth status (catalog from Pi). */
export async function listProviders(credsDir: string, piDir: string): Promise<ProviderAuthInfo[]> {
  return joinProviderCatalog(credsDir, await listPiProviders(credsDir, piDir));
}
