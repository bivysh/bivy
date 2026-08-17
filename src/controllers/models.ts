// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Local-model controller — the custom/local model-provider domain lifted out of
// server.ts. Owns the Bivy local-model registry, its projection into Pi's
// models.json, and the save/remove flow that
// stitches secret keys into the encrypted vault. server.ts wires it with the
// node dirs + broadcast + the session-refresh / control-plane-sync hooks, then
// destructures the operations it calls.
//
// Imports store + credential functions directly (controllers may consume
// runtime/ and credentials/); imports nothing from server.ts (boundary enforced).
import fs from "node:fs";
import path from "node:path";

import {
  loadLocalModels,
  upsertLocalProvider,
  removeLocalProviderEntry,
  listLocalProviderSummaries,
  importLocalModels,
  toPiModelsConfig,
  normalizeProviderId,
  type LocalModelsConfig,
} from "../runtime/local-model-store.js";
import { exportProviderAuth, setProviderCredential, removeProvider } from "../credentials/api.js";
import {
  discoverLocalModels,
  getLocalModelReadiness,
  isLoopbackHostname,
  verifyLocalModelEndpoint,
  type LocalEndpointResult,
} from "../runtime/local-model-discovery.js";

// Keys the projection treats as "no real key" — local servers accept anything,
// so these never enter the encrypted vault as a real key.
const DUMMY_LOCAL_KEYS = new Set(["local", "ollama", "lm-studio", "vllm", "sglang", "none", ""]);

type StoredKeyMap = Record<string, { type?: string; key?: string }>;

export interface ModelControllerDeps {
  localModelsDir: string;
  piDir: string;
  piModelsProjectionPath: string;
  credsDir: string;
  broadcast(payload: unknown): void;
  /** Re-resolve session credentials after a model-auth change. */
  refreshSessionAfterAuth(): Promise<unknown>;
  /** Push the updated model-auth vault to the control plane (best-effort). */
  pushModelAuthToControlPlane(): Promise<unknown>;
  machine: { id: string; name: string };
}

export function createModelController(deps: ModelControllerDeps) {
  const { localModelsDir, piDir, piModelsProjectionPath, credsDir, broadcast, refreshSessionAfterAuth, pushModelAuthToControlPlane, machine } = deps;

  function isLoopbackEndpoint(baseUrl: string): boolean {
    try {
      return isLoopbackHostname(new URL(baseUrl).hostname);
    } catch {
      return false;
    }
  }

  function onThisMachine(result: LocalEndpointResult) {
    return { ...result, machineId: machine.id, machineName: machine.name };
  }

  /** The env var a generic (non-Pi) agent reads to reach this endpoint's base URL,
   *  chosen by API family. Injected only for the active provider (see credentials.ts). */
  function agentEnvForEndpoint(api: string, baseUrl: string): Record<string, string> {
    const url = String(baseUrl ?? "").trim();
    if (!url) return {};
    const a = String(api ?? "").toLowerCase();
    if (a.startsWith("azure")) return { AZURE_OPENAI_BASE_URL: url };
    if (a.startsWith("anthropic")) return { ANTHROPIC_BASE_URL: url };
    return { OPENAI_BASE_URL: url };
  }

  /** Snapshot of vault credentials, keyed by provider id (best-effort). */
  async function currentProviderKeys(): Promise<StoredKeyMap> {
    try {
      return (await exportProviderAuth(credsDir)) as StoredKeyMap;
    } catch {
      return {};
    }
  }

  /** Regenerate Pi's models.json from Bivy's registry, stitching in vault keys.
   *  The registry holds no secrets — the API key is resolved from the encrypted
   *  vault here, so it only ever lands in this local 0600 derived file. */
  async function writePiModelsProjection(cfg?: LocalModelsConfig): Promise<void> {
    const registry = cfg ?? loadLocalModels(localModelsDir);
    const keys = await currentProviderKeys();
    const resolveKey = (id: string) => {
      const c = keys[id];
      return c && c.type === "api_key" ? c.key : undefined;
    };
    try {
      fs.mkdirSync(piDir, { recursive: true });
      fs.writeFileSync(piModelsProjectionPath, `${JSON.stringify(toPiModelsConfig(registry, resolveKey, machine.id), null, 2)}\n`, { mode: 0o600 });
      try { fs.chmodSync(piModelsProjectionPath, 0o600); } catch {}
    } catch (error) {
      console.warn("[local-models] could not write Pi projection:", (error as Error).message);
    }
  }

  /** Redacted summaries for the UI, with `hasKey` derived from the vault. */
  async function localModelSummaries() {
    const keys = await currentProviderKeys();
    return listLocalProviderSummaries(localModelsDir, (id) => {
      const c = keys[id];
      return !!c && c.type === "api_key" && !!c.key;
    }, machine.id);
  }

  /** One-time migration: adopt any pre-existing pi/models.json into Bivy's store,
   *  moving inline API keys into the encrypted vault. */
  async function migrateLegacyPiModelsIntoRegistry(): Promise<void> {
    try {
      if (fs.existsSync(path.join(localModelsDir, "local-models.json"))) return; // already own it
      if (!fs.existsSync(piModelsProjectionPath)) return;
      const legacy = JSON.parse(fs.readFileSync(piModelsProjectionPath, "utf8"));
      const providers = legacy?.providers;
      if (!providers || typeof providers !== "object" || !Object.keys(providers).length) return;
      for (const [id, spec] of Object.entries<any>(providers)) {
        const nid = normalizeProviderId(id);
        const key = spec?.apiKey;
        const realKey = key && !DUMMY_LOCAL_KEYS.has(String(key).toLowerCase()) ? String(key) : undefined;
        await setProviderCredential(credsDir, nid, {
          key: realKey,
          env: agentEnvForEndpoint(String(spec?.api ?? ""), String(spec?.baseUrl ?? "")),
        }).catch(() => {});
      }
      const migrated: Record<string, unknown> = {};
      for (const [id, spec] of Object.entries<any>(providers)) {
        migrated[id] = isLoopbackEndpoint(String(spec?.baseUrl ?? ""))
          ? { ...spec, scope: "machine", machineId: machine.id, machineName: machine.name }
          : { ...spec, scope: "network" };
      }
      importLocalModels(localModelsDir, migrated); // normalizeProvider drops apiKey
      console.log("[local-models] migrated legacy pi/models.json into Bivy registry (keys → vault)");
    } catch (error) {
      console.warn("[local-models] legacy migration skipped:", (error as Error).message);
    }
  }

  // Adopt any legacy Pi-owned config (keys → vault), then ensure the projection
  // reflects the Bivy registry from the very first boot.
  async function initLocalModelRegistry(): Promise<void> {
    await migrateLegacyPiModelsIntoRegistry();
    // Registries created before Machine scoping had no owner marker. Claim only
    // their loopback entries on the Machine performing this migration; remote
    // custom endpoints intentionally remain network-scoped.
    const existing = loadLocalModels(localModelsDir);
    let claimedLegacy = false;
    for (const [id, provider] of Object.entries(existing.providers)) {
      if (!provider.scope && isLoopbackEndpoint(provider.baseUrl)) {
        existing.providers[id] = { ...provider, scope: "machine", machineId: machine.id, machineName: machine.name };
        claimedLegacy = true;
      }
    }
    if (claimedLegacy) {
      for (const [id, provider] of Object.entries(existing.providers)) upsertLocalProvider(localModelsDir, id, provider);
    }
    await writePiModelsProjection();
  }

  /** Normalize save input into a provider id, non-secret spec, and separate key. */
  function localModelSpecFromInput(input: any): { providerId: string; spec: any; apiKey?: string } {
    const { providerId, baseUrl, api, apiKey, models, compat, name } = input || {};
    if (!baseUrl) throw new Error("baseUrl is required");
    const normalizedBaseUrl = String(baseUrl).trim();
    const loopback = isLoopbackEndpoint(normalizedBaseUrl);
    const requestedId = providerId || "local";
    // Machine-scoped ids include a stable node suffix so two Machines running
    // Ollama do not overwrite each other when the registry syncs.
    const suffix = `-${machine.id.slice(0, 8)}`;
    const existing = loadLocalModels(localModelsDir).providers[normalizeProviderId(String(requestedId))];
    const alreadyOwnedHere = existing?.scope === "machine" && existing.machineId === machine.id;
    const scopedId = loopback && !alreadyOwnedHere && !String(requestedId).endsWith(suffix) ? `${requestedId}${suffix}` : requestedId;
    const spec: any = {
      baseUrl: normalizedBaseUrl,
      api: api || "openai-completions",
      scope: loopback ? "machine" : "network",
      ...(loopback ? { machineId: machine.id, machineName: machine.name } : {}),
    };
    if (name) spec.name = String(name);
    if (compat && typeof compat === "object") spec.compat = compat;
    spec.models = Array.isArray(models) ? models : [];
    const key = apiKey === undefined || apiKey === null ? undefined : String(apiKey);
    return { providerId: scopedId, spec, apiKey: key };
  }

  /** User-initiated only: probe the fixed loopback allowlist on this Machine. */
  async function discoverModelsOnMachine() {
    const endpoints = (await discoverLocalModels()).map(onThisMachine);
    return { machineId: machine.id, machineName: machine.name, endpoints, readiness: getLocalModelReadiness(endpoints) };
  }

  /** Verify one explicitly entered endpoint. Non-loopback is allowed because the
   * user supplied it, while the verifier still rejects unsafe SSRF targets. */
  async function verifyModelEndpoint(input: any) {
    const result = await verifyLocalModelEndpoint({
      baseUrl: String(input?.baseUrl ?? ""),
      apiKey: input?.apiKey ? String(input.apiKey) : undefined,
      allowNonLoopback: true,
    });
    return onThisMachine(result);
  }

  /** Re-emit the local-model list to every connected client (relay + direct). */
  async function broadcastLocalModels(): Promise<void> {
    broadcast({ type: "models.custom.list", providers: await localModelSummaries() });
    broadcast({ type: "models.custom.updated" });
  }

  /** Save a provider: non-secret config → registry, secret key → encrypted vault,
   *  then re-project Pi + refresh + sync + notify clients. */
  async function persistLocalModelSave(input: any): Promise<{ id: string }> {
    const { providerId, spec, apiKey } = localModelSpecFromInput(input);
    const { id } = upsertLocalProvider(localModelsDir, providerId, spec);
    // Store the endpoint's base URL alongside the (encrypted) key so non-Pi agents
    // can reach it when it's the active provider. Only a real key is kept — blank
    // on edit preserves the existing key; local dummies ("ollama"/…) are dropped
    // so they don't read as a configured key (projection falls back to "local").
    const trimmedKey = apiKey?.trim();
    const realKey = trimmedKey && !DUMMY_LOCAL_KEYS.has(trimmedKey.toLowerCase()) ? trimmedKey : undefined;
    await setProviderCredential(credsDir, id, { key: realKey, env: agentEnvForEndpoint(spec.api, spec.baseUrl) });
    await writePiModelsProjection();
    await refreshSessionAfterAuth();
    void pushModelAuthToControlPlane().catch(() => {});
    await broadcastLocalModels();
    return { id };
  }

  /** Remove a provider: drop its registry config AND forget its stored key. */
  async function persistLocalModelRemove(id: string): Promise<void> {
    const pid = normalizeProviderId(String(id ?? ""));
    if (!pid) throw new Error("provider id required");
    removeLocalProviderEntry(localModelsDir, pid);
    await removeProvider(credsDir, pid).catch(() => {}); // forget the vault key too
    await writePiModelsProjection();
    await refreshSessionAfterAuth();
    void pushModelAuthToControlPlane().catch(() => {});
    await broadcastLocalModels();
  }

  return {
    writePiModelsProjection,
    localModelSummaries,
    broadcastLocalModels,
    persistLocalModelSave,
    persistLocalModelRemove,
    initLocalModelRegistry,
    discoverModelsOnMachine,
    verifyModelEndpoint,
  };
}
