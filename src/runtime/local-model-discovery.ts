// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// User-initiated discovery for inference servers on this Machine. The default
// candidate list is deliberately finite and loopback-only: this is not a LAN
// scanner. Custom verification is explicit and applies URL/DNS SSRF guards.

import dns from "node:dns/promises";
import net from "node:net";

export type LocalEndpointStatus = "ready" | "offline" | "timeout" | "auth_required" | "malformed" | "unsupported";

export interface DiscoveredLocalModel {
  id: string;
  name: string;
}

export interface LocalEndpointResult {
  candidateId?: string;
  name?: string;
  baseUrl: string;
  api: "openai-completions";
  status: LocalEndpointStatus;
  models: DiscoveredLocalModel[];
  detail?: string;
  authenticated?: boolean;
}

export interface LocalModelReadiness {
  ready: boolean;
  readyEndpointCount: number;
  modelCount: number;
  state: "ready" | "auth_required" | "unavailable" | "unknown";
}

export interface LocalDiscoveryCandidate {
  id: string;
  name: string;
  baseUrl: string;
  catalogUrl: string;
  catalog: "openai" | "ollama";
}

/** Stable, auditable allowlist. Discovery must never derive hosts from input. */
export const LOCAL_DISCOVERY_CANDIDATES: readonly LocalDiscoveryCandidate[] = Object.freeze([
  { id: "ollama", name: "Ollama", baseUrl: "http://127.0.0.1:11434/v1", catalogUrl: "http://127.0.0.1:11434/api/tags", catalog: "ollama" },
  { id: "lm-studio", name: "LM Studio", baseUrl: "http://127.0.0.1:1234/v1", catalogUrl: "http://127.0.0.1:1234/v1/models", catalog: "openai" },
  { id: "vllm", name: "vLLM / OpenAI compatible", baseUrl: "http://127.0.0.1:8000/v1", catalogUrl: "http://127.0.0.1:8000/v1/models", catalog: "openai" },
  { id: "sglang", name: "SGLang", baseUrl: "http://127.0.0.1:30000/v1", catalogUrl: "http://127.0.0.1:30000/v1/models", catalog: "openai" },
]);

const DEFAULT_TIMEOUT_MS = 1_500;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_MODELS = 200;

type FetchLike = typeof fetch;
type Lookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

export interface VerifyLocalEndpointOptions {
  baseUrl: string;
  apiKey?: string;
  /** False is the safe default. The UI sets this only for a user-entered custom URL. */
  allowNonLoopback?: boolean;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  lookup?: Lookup;
}

function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.startsWith("127.");
}

function unsafeAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const octets = address.split(".").map(Number);
    return octets[0] === 0 || octets[0] === 127 || (octets[0] === 169 && octets[1] === 254) || octets[0] >= 224;
  }
  const value = address.toLowerCase().split("%")[0];
  return value === "::" || value === "::1" || value.startsWith("fe8") || value.startsWith("fe9") || value.startsWith("fea") || value.startsWith("feb") || value.startsWith("ff");
}

/** Validate a custom verification target. Private RFC1918 addresses are allowed
 * only after an explicit user action; link-local, metadata-adjacent, multicast,
 * unspecified, credentials-in-URL, and non-HTTP targets are always rejected. */
export async function validateLocalEndpointUrl(
  raw: string,
  options: { allowNonLoopback?: boolean; lookup?: Lookup } = {},
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(String(raw ?? "").trim());
  } catch {
    throw new Error("Enter a valid endpoint URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Endpoint must use http:// or https://.");
  if (url.username || url.password) throw new Error("Endpoint URLs cannot contain credentials; use the API key field.");
  if (!url.hostname) throw new Error("Endpoint hostname is required.");
  if (isLoopback(url.hostname)) return url;
  if (!options.allowNonLoopback) throw new Error("Discovery is limited to this Machine (localhost). Add remote endpoints explicitly.");

  const literalFamily = net.isIP(url.hostname);
  const addresses = literalFamily
    ? [{ address: url.hostname, family: literalFamily }]
    : await (options.lookup ?? (async (hostname) => dns.lookup(hostname, { all: true })))(url.hostname);
  if (!addresses.length) throw new Error("Endpoint hostname did not resolve.");
  if (addresses.some(({ address }) => unsafeAddress(address))) {
    throw new Error("Endpoint resolves to a blocked loopback, link-local, unspecified, or multicast address.");
  }
  return url;
}

function catalogUrl(baseUrl: URL): URL {
  const url = new URL(baseUrl.href);
  url.search = "";
  url.hash = "";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/models`.replace(/\/v1\/models\/models$/, "/v1/models");
  return url;
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > MAX_RESPONSE_BYTES) throw new Error("catalog response is too large");
  if (!response.body) return JSON.parse(await response.text());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("catalog response is too large");
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(merged));
}

export function normalizeCatalog(payload: unknown, kind: "openai" | "ollama"): DiscoveredLocalModel[] {
  const root = payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
  const entries = kind === "ollama" ? root?.models : root?.data;
  if (!Array.isArray(entries)) throw new Error(kind === "ollama" ? "expected an Ollama models catalog" : "expected an OpenAI-compatible models catalog");
  const seen = new Set<string>();
  const models: DiscoveredLocalModel[] = [];
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const id = String(kind === "ollama" ? item.name ?? item.model ?? "" : item.id ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, name: String(item.name ?? id).trim() || id });
    if (models.length === MAX_MODELS) break;
  }
  return models;
}

async function probe(
  target: { baseUrl: string; catalogUrl: string; catalog: "openai" | "ollama"; candidateId?: string; name?: string },
  options: { apiKey?: string; timeoutMs?: number; fetchImpl?: FetchLike },
): Promise<LocalEndpointResult> {
  const timeoutMs = Math.max(50, Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 5_000));
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const base: Omit<LocalEndpointResult, "status" | "models"> = {
    ...(target.candidateId ? { candidateId: target.candidateId } : {}),
    ...(target.name ? { name: target.name } : {}),
    baseUrl: target.baseUrl,
    api: "openai-completions",
  };
  try {
    const response = await Promise.race([
      (options.fetchImpl ?? fetch)(target.catalogUrl, {
        method: "GET",
        headers: { accept: "application/json", ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}) },
        redirect: "error",
        signal: controller.signal,
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("request timed out")), timeoutMs)),
    ]);
    if (response.status === 401 || response.status === 403) return { ...base, status: "auth_required", models: [], detail: "The endpoint requires an API key." };
    if (response.status === 404 || response.status === 405) return { ...base, status: "unsupported", models: [], detail: "The endpoint does not expose a compatible model catalog." };
    if (!response.ok) return { ...base, status: "offline", models: [], detail: `Endpoint returned HTTP ${response.status}.` };
    try {
      const models = normalizeCatalog(await boundedJson(response), target.catalog);
      return { ...base, status: "ready", models, ...(options.apiKey ? { authenticated: true } : {}) };
    } catch (error) {
      return { ...base, status: "malformed", models: [], detail: `Catalog format was not recognized: ${(error as Error).message}. The server may use a different version.` };
    }
  } catch (error) {
    const timeout = timedOut || (error as Error)?.name === "AbortError" || /timed out/i.test(String((error as Error)?.message));
    return { ...base, status: timeout ? "timeout" : "offline", models: [], detail: timeout ? `No response within ${timeoutMs} ms.` : "Could not connect to the endpoint." };
  } finally {
    clearTimeout(timer);
  }
}

/** Probe only the fixed loopback allowlist. Must be called from a user action. */
export async function discoverLocalModels(options: { timeoutMs?: number; fetchImpl?: FetchLike } = {}): Promise<LocalEndpointResult[]> {
  return Promise.all(LOCAL_DISCOVERY_CANDIDATES.map((candidate) => probe({ ...candidate, candidateId: candidate.id }, options)));
}

/** Verify and list models at one explicitly entered endpoint. */
export async function verifyLocalModelEndpoint(options: VerifyLocalEndpointOptions): Promise<LocalEndpointResult> {
  const base = await validateLocalEndpointUrl(options.baseUrl, { allowNonLoopback: options.allowNonLoopback, lookup: options.lookup });
  return probe({ baseUrl: base.href.replace(/\/$/, ""), catalogUrl: catalogUrl(base).href, catalog: "openai" }, options);
}

/** Stable readiness projection for future Machine capability inventory consumers. */
export function getLocalModelReadiness(results: readonly LocalEndpointResult[]): LocalModelReadiness {
  const ready = results.filter((result) => result.status === "ready");
  const modelCount = new Set(ready.flatMap((result) => result.models.map((model) => `${result.baseUrl}\0${model.id}`))).size;
  return {
    ready: ready.length > 0 && modelCount > 0,
    readyEndpointCount: ready.length,
    modelCount,
    state: ready.length > 0 ? "ready" : results.some((result) => result.status === "auth_required") ? "auth_required" : results.length ? "unavailable" : "unknown",
  };
}
