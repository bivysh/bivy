// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// User-initiated discovery for inference servers on this Machine. The default
// candidate list is deliberately finite and loopback-only: this is not a LAN
// scanner. Custom verification is explicit and applies URL/DNS SSRF guards.

import dns from "node:dns/promises";
import net from "node:net";
import { Agent } from "undici";

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

function mappedIpv4(address: string): string | undefined {
  const dotted = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (dotted) return dotted;
  const hex = address.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!hex) return undefined;
  const high = Number.parseInt(hex[1], 16);
  const low = Number.parseInt(hex[2], 16);
  return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
}

export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const mapped = mappedIpv4(host);
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.startsWith("127.") || !!mapped?.startsWith("127.");
}

function unsafeAddress(address: string): boolean {
  const value = address.toLowerCase().split("%")[0];
  const mappedV4 = mappedIpv4(value);
  if (mappedV4) return unsafeAddress(mappedV4);
  if (net.isIPv4(value)) {
    const octets = value.split(".").map(Number);
    return octets[0] === 0
      || octets[0] === 127
      || (octets[0] === 169 && octets[1] === 254)
      || value === "100.100.100.200"
      || value === "192.0.0.192"
      || octets[0] >= 224;
  }
  return value === "::"
    || value === "::1"
    || value === "fd00:ec2::254"
    || value.startsWith("fe8")
    || value.startsWith("fe9")
    || value.startsWith("fea")
    || value.startsWith("feb")
    || value.startsWith("ff");
}

/** Validate a custom verification target. Private RFC1918 addresses are allowed
 * only after an explicit user action; link-local, metadata-adjacent, multicast,
 * unspecified, credentials-in-URL, and non-HTTP targets are always rejected. */
async function resolveLocalEndpointUrl(
  raw: string,
  options: { allowNonLoopback?: boolean; lookup?: Lookup } = {},
): Promise<{ url: URL; addresses: Array<{ address: string; family: number }> }> {
  let url: URL;
  try {
    url = new URL(String(raw ?? "").trim());
  } catch {
    throw new Error("Enter a valid endpoint URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Endpoint must use http:// or https://.");
  if (url.username || url.password) throw new Error("Endpoint URLs cannot contain credentials; use the API key field.");
  if (!url.hostname) throw new Error("Endpoint hostname is required.");
  if (isLoopbackHostname(url.hostname)) {
    const address = url.hostname.replace(/^\[|\]$/g, "") === "::1" ? "::1" : "127.0.0.1";
    return { url, addresses: [{ address, family: net.isIP(address) }] };
  }
  if (!options.allowNonLoopback) throw new Error("Discovery is limited to this Machine (localhost). Add remote endpoints explicitly.");

  const literalFamily = net.isIP(url.hostname);
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = literalFamily
      ? [{ address: url.hostname, family: literalFamily }]
      : await (options.lookup ?? (async (hostname) => dns.lookup(hostname, { all: true })))(url.hostname);
  } catch {
    throw new Error("Endpoint hostname could not be resolved.");
  }
  if (!addresses.length) throw new Error("Endpoint hostname did not resolve.");
  if (addresses.some(({ address }) => unsafeAddress(address))) {
    throw new Error("Endpoint resolves to a blocked loopback, link-local, unspecified, or multicast address.");
  }
  return { url, addresses };
}

export async function validateLocalEndpointUrl(
  raw: string,
  options: { allowNonLoopback?: boolean; lookup?: Lookup } = {},
): Promise<URL> {
  return (await resolveLocalEndpointUrl(raw, options)).url;
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
  options: { apiKey?: string; timeoutMs?: number; fetchImpl?: FetchLike; dispatcher?: Agent },
): Promise<LocalEndpointResult> {
  const timeoutMs = Math.max(50, Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 5_000));
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error("request timed out"));
    }, timeoutMs);
  });
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
        ...(options.dispatcher ? { dispatcher: options.dispatcher } : {}),
      } as RequestInit),
      timeout,
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
    clearTimeout(timer!);
  }
}

/** Probe only the fixed loopback allowlist. Must be called from a user action. */
export async function discoverLocalModels(options: { timeoutMs?: number; fetchImpl?: FetchLike } = {}): Promise<LocalEndpointResult[]> {
  return Promise.all(LOCAL_DISCOVERY_CANDIDATES.map((candidate) => probe({ ...candidate, candidateId: candidate.id }, options)));
}

/** Verify and list models at one explicitly entered endpoint. */
export async function verifyLocalModelEndpoint(options: VerifyLocalEndpointOptions): Promise<LocalEndpointResult> {
  const resolved = await resolveLocalEndpointUrl(options.baseUrl, { allowNonLoopback: options.allowNonLoopback, lookup: options.lookup });
  const base = resolved.url;
  // Pin hostname resolution for this request. Validation followed by an ordinary
  // second DNS lookup would leave a rebinding window into a blocked address.
  const pinned = resolved.addresses[0];
  const dispatcher = net.isIP(base.hostname)
    ? undefined
    : new Agent({
        connect: {
          lookup: ((_hostname: string, _lookupOptions: unknown, callback: (error: Error | null, address: string, family: number) => void) => {
            callback(null, pinned.address, pinned.family);
          }) as any,
        },
      });
  try {
    return await probe({ baseUrl: base.href.replace(/\/$/, ""), catalogUrl: catalogUrl(base).href, catalog: "openai" }, { ...options, dispatcher });
  } finally {
    await dispatcher?.close();
  }
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
