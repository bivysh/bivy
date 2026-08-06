// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Bivy's app-owned local/custom model registry — the source of truth for
// user-provided model endpoints (Ollama, LM Studio, vLLM, SGLang, and any
// OpenAI-compatible / self-hosted inference server).
//
// This module is deliberately PI-FREE (no import from any @earendil-works
// package, not even a type), mirroring credential-store.ts. Bivy owns the
// storage and the registry shape; Pi consumes it as just another agent via a
// derived projection into its own `models.json` (see server.ts writePiModelsProjection).
//
// The registry holds NON-SECRET configuration ONLY: base URLs, API shape, and
// model metadata (context window, cost, reasoning capability). It never stores
// API keys — those live in Bivy's encrypted credential vault
// (credential-store.ts), keyed by the same provider id, and are stitched back
// in only when projecting Pi's models.json. The registry rides the existing
// encrypted control-plane push so custom endpoints follow the account across
// nodes and devices; the keys ride the credential half of that same push.

import fs from "node:fs";
import path from "node:path";

/** One model exposed by a local/custom provider. */
export interface LocalModel {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

/** A user-provided model provider (OpenAI-compatible endpoint by default).
 *  Non-secret config only — the API key is never stored here (see module doc). */
export interface LocalProvider {
  id: string;
  name?: string;
  baseUrl: string;
  api: string;
  compat?: Record<string, unknown>;
  models: LocalModel[];
}

export interface LocalModelsConfig {
  providers: Record<string, LocalProvider>;
}

/** Redacted summary for enumeration — never leaks the raw apiKey. */
export interface LocalProviderSummary {
  id: string;
  name?: string;
  baseUrl: string;
  api: string;
  hasKey: boolean;
  modelCount: number;
  models: Array<{ id: string; name: string }>;
}

const FILE_NAME = "local-models.json";
const DEFAULT_BASE_URL = "http://localhost:11434/v1";
const DEFAULT_API = "openai-completions";

function configPath(dir: string): string {
  return path.join(dir, FILE_NAME);
}

/** Normalize a provider id the way every path expects (slug-safe). */
export function normalizeProviderId(id: string): string {
  return (
    String(id ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-") // non-slug runs collapse to a single dash
      .replace(/^-+|-+$/g, "") // no leading/trailing dashes
      || "local"
  );
}

function normalizeModel(raw: any): LocalModel | null {
  const id = String(raw?.id ?? "").trim();
  if (!id) return null;
  return {
    id,
    name: raw?.name ? String(raw.name) : undefined,
    reasoning: !!raw?.reasoning,
    input: Array.isArray(raw?.input) && raw.input.length ? raw.input.map((x: unknown) => String(x)) : ["text"],
    contextWindow: Number(raw?.contextWindow) || 128000,
    maxTokens: Number(raw?.maxTokens) || 16384,
    cost:
      raw?.cost && typeof raw.cost === "object"
        ? {
            input: Number(raw.cost.input) || 0,
            output: Number(raw.cost.output) || 0,
            cacheRead: Number(raw.cost.cacheRead) || 0,
            cacheWrite: Number(raw.cost.cacheWrite) || 0,
          }
        : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

/** Coerce arbitrary input into a normalized provider (drops empty models). */
export function normalizeProvider(id: string, raw: any): LocalProvider {
  const models = Array.isArray(raw?.models)
    ? raw.models.map(normalizeModel).filter((m: LocalModel | null): m is LocalModel => !!m)
    : [];
  const provider: LocalProvider = {
    id: normalizeProviderId(id),
    baseUrl: String(raw?.baseUrl ?? "").trim() || DEFAULT_BASE_URL,
    api: String(raw?.api ?? "").trim() || DEFAULT_API,
    models,
  };
  if (raw?.name) provider.name = String(raw.name);
  if (raw?.compat && typeof raw.compat === "object") provider.compat = raw.compat as Record<string, unknown>;
  // Any incoming `apiKey` is intentionally dropped — keys live in the vault.
  return provider;
}

export function loadLocalModels(dir: string): LocalModelsConfig {
  const file = configPath(dir);
  if (!fs.existsSync(file)) return { providers: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object") return { providers: {} };
    const providersRaw = (parsed as any).providers;
    if (!providersRaw || typeof providersRaw !== "object") return { providers: {} };
    const providers: Record<string, LocalProvider> = {};
    for (const [id, spec] of Object.entries(providersRaw)) {
      const norm = normalizeProvider(id, spec);
      providers[norm.id] = norm;
    }
    return { providers };
  } catch {
    return { providers: {} };
  }
}

export function saveLocalModels(dir: string, cfg: LocalModelsConfig): void {
  fs.mkdirSync(dir, { recursive: true });
  const safe: LocalModelsConfig = { providers: (cfg && cfg.providers) || {} };
  const file = configPath(dir);
  fs.writeFileSync(file, `${JSON.stringify(safe, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort */
  }
}

/** Insert or update one provider; returns the normalized id and full config. */
export function upsertLocalProvider(dir: string, id: string, spec: any): { id: string; config: LocalModelsConfig } {
  const cfg = loadLocalModels(dir);
  const pid = normalizeProviderId(id);
  const prev = cfg.providers[pid];
  // Merge onto any existing entry so a partial save (e.g. just a new model)
  // doesn't clobber the base URL. Explicit fields in `spec` win.
  const merged = normalizeProvider(pid, { ...(prev ?? {}), ...(spec ?? {}) });
  cfg.providers[pid] = merged;
  saveLocalModels(dir, cfg);
  return { id: pid, config: cfg };
}

export function removeLocalProviderEntry(dir: string, id: string): LocalModelsConfig {
  const cfg = loadLocalModels(dir);
  delete cfg.providers[normalizeProviderId(id)];
  saveLocalModels(dir, cfg);
  return cfg;
}

/** Redacted list for the UI. `hasKey(id)` reports vault key presence (the store
 *  itself holds no keys), defaulting to false when no resolver is supplied. */
export function listLocalProviderSummaries(
  dir: string,
  hasKey: (id: string) => boolean = () => false,
): LocalProviderSummary[] {
  const cfg = loadLocalModels(dir);
  return Object.values(cfg.providers)
    .map((p) => ({
      id: p.id,
      name: p.name,
      baseUrl: p.baseUrl,
      api: p.api,
      hasKey: hasKey(p.id),
      modelCount: p.models.length,
      models: p.models.map((m) => ({ id: m.id, name: m.name || m.id })),
    }))
    .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
}

/** Raw registry map for the control-plane sync payload. */
export function exportLocalModels(dir: string): Record<string, LocalProvider> {
  return loadLocalModels(dir).providers;
}

/**
 * Merge a synced snapshot into the local registry. Non-destructive per the same
 * philosophy as credential import: incoming providers are applied on top; the
 * caller decides removals by re-pushing a snapshot without them (see server
 * sync). Returns true if anything actually changed.
 */
export function importLocalModels(dir: string, incoming: Record<string, unknown> | undefined): boolean {
  if (!incoming || typeof incoming !== "object") return false;
  const cfg = loadLocalModels(dir);
  let changed = false;
  for (const [id, spec] of Object.entries(incoming)) {
    if (!spec || typeof spec !== "object") continue;
    const norm = normalizeProvider(id, spec);
    if (JSON.stringify(cfg.providers[norm.id]) !== JSON.stringify(norm)) {
      cfg.providers[norm.id] = norm;
      changed = true;
    }
  }
  if (changed) saveLocalModels(dir, cfg);
  return changed;
}

/**
 * Project the Bivy registry into the shape Pi's ModelRuntime reads from
 * `models.json`. Pi only ever consumed custom/local providers from this file,
 * so a full regeneration from Bivy's registry is faithful and keeps Pi a pure
 * downstream consumer (never the source of truth).
 */
export function toPiModelsConfig(
  cfg: LocalModelsConfig,
  resolveKey: (id: string) => string | undefined = () => undefined,
): { providers: Record<string, unknown> } {
  const providers: Record<string, unknown> = {};
  for (const [id, p] of Object.entries(cfg.providers)) {
    providers[id] = {
      name: p.name,
      baseUrl: p.baseUrl,
      api: p.api,
      // Key comes from the vault; local servers ignore it, so "local" is a safe
      // default when none is stored (Ollama, LM Studio, vLLM, …).
      apiKey: resolveKey(id) || "local",
      ...(p.compat ? { compat: p.compat } : {}),
      // Stamp each model with the provider's api so Pi dispatches to the right
      // implementation (e.g. azure-openai-responses) even when a model omits it.
      models: p.models.map((m) => ({ api: p.api, ...m })),
    };
  }
  return { providers };
}
