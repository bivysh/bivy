// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Unified model catalog — aggregated across agents, not sourced from pi alone.
//
// Each agent runtime optionally exposes a session-less `listCatalog()` (its
// providers + models). Bivy unions them here into one catalog, deduped by
// provider/model, and stamps each provider with auth state from Bivy's own vault
// — so the "Models & providers" surface reflects what *any* installed agent can
// run, with pi as just one (rich) contributor. New api-key providers are
// supported dynamically (the provider→env mapping is generic); OAuth providers
// are those in Bivy's native registry.

import { BIVY_PROVIDER_CATALOG, BIVY_PROVIDER_CATALOG_VERSION, bivyProvider } from "./bivy-provider-catalog.js";
import type { AgentRuntime, CatalogProvider, ModelInfo } from "./types.js";
import { createCredentialVault } from "./credential-store.js";
import { isNativeOAuthProvider } from "./oauth/model-oauth-providers.js";

/** Non-secret origin/freshness metadata for one aggregated provider row. */
export interface CatalogProvenance {
  /** Version of Bivy's static snapshot, when this is a registered provider. */
  baselineVersion?: string;
  /** Runtimes that supplied live metadata in this aggregation. */
  runtimeIds: string[];
  /** Epoch ms at which live runtime metadata was observed. */
  refreshedAt?: number;
}

/** A provider in the unified catalog: baseline plus agents that offer it and its models. */
export interface AggregatedProvider {
  id: string;
  name: string;
  /** Subscription/OAuth login is available (Bivy natively owns it, or an agent offers it). */
  oauth: boolean;
  /** A credential is stored for this provider in Bivy's vault. */
  configured: boolean;
  /** Ids of the agents that can run this provider's models. */
  agents: string[];
  /** Baseline overlaid with live models, deduped by model id. */
  models: ModelInfo[];
  provenance?: CatalogProvenance;
}

async function catalogOf(runtime: AgentRuntime): Promise<CatalogProvider[]> {
  if (!runtime.listCatalog) return [];
  try {
    return await runtime.listCatalog();
  } catch {
    // A runtime that can't enumerate its catalog (CLI missing, offline) simply
    // contributes nothing rather than breaking the aggregate.
    return [];
  }
}

/**
 * Aggregate the model catalog across the given agent runtimes and stamp Bivy's
 * vault auth state onto each provider. Runtimes are queried concurrently; a
 * failing one is skipped.
 */
export async function aggregateModelCatalog(runtimes: AgentRuntime[], credsDir: string): Promise<AggregatedProvider[]> {
  const [perAgent, stored] = await Promise.all([
    Promise.all(runtimes.map(async (runtime) => ({ agent: runtime.id, providers: await catalogOf(runtime) }))),
    createCredentialVault(credsDir).list().catch(() => []),
  ]);
  const configured = new Set(stored.map((info) => bivyProvider(info.providerId)?.id ?? info.providerId));

  const byProvider = new Map<string, AggregatedProvider>();
  const seenModel = new Map<string, Set<string>>();

  // The baseline makes this useful with zero installed agents and offline. Live
  // catalogs below add availability and replace same-id model metadata with the
  // fresher runtime row while retaining models absent from runtime discovery.
  for (const provider of BIVY_PROVIDER_CATALOG) {
    const models: ModelInfo[] = provider.models.map((model) => ({ provider: provider.id, ...model }));
    byProvider.set(provider.id, {
      id: provider.id,
      name: provider.name,
      oauth: provider.authMethods.some((method) => method.kind === "oauth"),
      configured: configured.has(provider.id),
      agents: [],
      models,
      provenance: { baselineVersion: BIVY_PROVIDER_CATALOG_VERSION, runtimeIds: [] },
    });
    seenModel.set(provider.id, new Set(models.map((model) => model.id)));
  }

  const refreshedAt = Date.now();
  for (const { agent, providers } of perAgent) {
    for (const provider of providers) {
      const rawId = provider.id.trim().toLowerCase();
      if (!rawId) continue;
      const definition = bivyProvider(rawId);
      const id = definition?.id ?? rawId;
      let entry = byProvider.get(id);
      if (!entry) {
        entry = {
          id,
          name: provider.name || id,
          oauth: isNativeOAuthProvider(id),
          configured: configured.has(id),
          agents: [],
          models: [],
          provenance: { runtimeIds: [], refreshedAt },
        };
        byProvider.set(id, entry);
        seenModel.set(id, new Set());
      }
      if (provider.oauth) entry.oauth = true;
      if (!entry.agents.includes(agent)) entry.agents.push(agent);
      const provenance = entry.provenance ??= { runtimeIds: [] };
      if (!provenance.runtimeIds.includes(agent)) provenance.runtimeIds.push(agent);
      provenance.refreshedAt = refreshedAt;
      const models = seenModel.get(id)!;
      for (const model of provider.models) {
        const normalized = { ...model, provider: id };
        if (models.has(model.id)) {
          const index = entry.models.findIndex((candidate) => candidate.id === model.id);
          if (index >= 0) entry.models[index] = normalized;
          continue;
        }
        models.add(model.id);
        entry.models.push(normalized);
      }
    }
  }

  return [...byProvider.values()]
    .map((provider) => ({ ...provider, models: provider.models.sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** A provider row for the "Models & providers" screen — auth status + which agents run it. */
export interface UnifiedProvider {
  id: string;
  name: string;
  oauth: boolean;
  configured: boolean;
  kind?: "api_key" | "oauth";
  source?: string;
  /** Agent ids that can run this provider's models. */
  agents: string[];
  /** Models offered by the baseline and across agents. */
  models: ModelInfo[];
  provenance?: CatalogProvenance;
}

type ProviderStatus = { id: string; name: string; oauth: boolean; configured: boolean; kind?: "api_key" | "oauth"; source?: string };

/**
 * Merge an authoritative per-provider auth status (from the base agent, which
 * knows env vs stored) with the cross-agent catalog. Base rows keep their status
 * and gain `agents`/`models`; providers only other agents know about are appended
 * with the catalog's vault-derived status. Pure — the whole reason it's testable.
 */
export function mergeProviderCatalog(base: ProviderStatus[], catalog: AggregatedProvider[]): UnifiedProvider[] {
  const byId = new Map<string, UnifiedProvider>();
  for (const row of base) byId.set(row.id, { ...row, agents: [], models: [] });
  for (const provider of catalog) {
    const existing = byId.get(provider.id);
    if (existing) {
      existing.agents = provider.agents;
      existing.models = provider.models;
      existing.provenance = provider.provenance;
      if (provider.oauth) existing.oauth = true;
    } else {
      byId.set(provider.id, {
        id: provider.id,
        name: provider.name,
        oauth: provider.oauth,
        configured: provider.configured,
        agents: provider.agents,
        models: provider.models,
        provenance: provider.provenance,
      });
    }
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}
