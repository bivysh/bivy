// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Data-driven composition root for provider interpreters.

import type { ExecFn, ProviderAdapter } from "./ephemeral-provider-ports.js";
import { awsProvider } from "./ephemeral-providers/aws.js";
import { e2bProvider } from "./ephemeral-providers/e2b.js";
import { flyProvider } from "./ephemeral-providers/fly.js";
import { hetznerProvider } from "./ephemeral-providers/hetzner.js";
import { spritesProvider } from "./ephemeral-providers/sprites.js";

/** Registration order is stable for consumers that enumerate interpreters. */
export const EPHEMERAL_PROVIDER_ADAPTERS: readonly ProviderAdapter[] = [
  hetznerProvider,
  flyProvider,
  awsProvider,
  spritesProvider,
  e2bProvider,
];

const adaptersById = new Map(EPHEMERAL_PROVIDER_ADAPTERS.map((adapter) => [adapter.id, adapter]));

export function ephemeralAdapter(id: string): ProviderAdapter | null {
  return adaptersById.get(String(id || "").trim().toLowerCase()) || null;
}

export async function validateEphemeralProviderToken(
  provider: string,
  token: string,
  exec: ExecFn,
  region?: string,
): Promise<void> {
  const adapter = ephemeralAdapter(provider);
  if (!adapter) throw new Error(`Unknown provider: ${provider}`);
  const value = String(token || "").trim();
  if (!value) throw new Error(`${adapter.name} token is required`);
  if (!adapter.validateToken) throw new Error(`${adapter.name} credential validation is not available`);
  await adapter.validateToken({ exec, token: value, region: region || adapter.defaultRegion });
}
