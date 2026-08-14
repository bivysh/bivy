// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Device-local persistence effects. Data normalization depends inward on the
// pure provider catalog; no provider adapter or transport implementation is used.

import type { EphemeralNodeConfig } from "./account.js";
import type { Command, PromptAttachment } from "./protocol.js";
import type { EphemeralMachine } from "./ephemeral-machine.js";
import { EPHEMERAL_PROVIDERS, ephemeralCatalogEntry } from "./ephemeral-catalog.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

function nowIso(): string {
  try { return new Date().toISOString(); } catch { return ""; }
}

function randHex(bytes: number): string {
  const arr = crypto.getRandomValues(new Uint8Array(bytes));
  return [...arr].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// --- device-local stores (provider tokens, launched machines) --------------

export interface KvBackend {
  getAll(): Promise<any[]>;
  put(key: string, value: any): Promise<void>;
  delete(key: string): Promise<void>;
}

export function memoryBackend(): KvBackend {
  const map = new Map<string, any>();
  return {
    async getAll() {
      return [...map.values()].map((r) => ({ ...r }));
    },
    async put(key, value) {
      map.set(key, { ...value });
    },
    async delete(key) {
      map.delete(key);
    },
  };
}

export function indexedDbBackend(idb: IDBFactory, dbName: string, storeName: string, keyPath: string): KvBackend {
  function open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = idb.open(dbName, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(storeName)) req.result.createObjectStore(storeName, { keyPath });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  function store(db: IDBDatabase, mode: IDBTransactionMode) {
    return db.transaction(storeName, mode).objectStore(storeName);
  }
  function promisify<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return {
    async getAll() {
      const db = await open();
      try {
        return (await promisify(store(db, "readonly").getAll())) || [];
      } finally {
        db.close();
      }
    },
    async put(_key, value) {
      const db = await open();
      try {
        await promisify(store(db, "readwrite").put(value));
      } finally {
        db.close();
      }
    },
    async delete(key) {
      const db = await open();
      try {
        await promisify(store(db, "readwrite").delete(key));
      } finally {
        db.close();
      }
    },
  };
}

function defaultBackend(storeName: string, keyPath: string): KvBackend {
  try {
    const idb = (globalThis as any).indexedDB as IDBFactory | undefined;
    // Each store gets its own database. They used to share one DB opened at a
    // fixed version, so `onupgradeneeded` only ran for whichever store opened
    // first — the others were never created and their transactions failed with
    // "object store not found". One DB per store sidesteps that entirely. The
    // token store keeps the original DB name so already-saved tokens survive.
    if (idb) {
      const dbName = storeName === "provider-keys" ? "bivy-ephemeral" : `bivy-ephemeral-${storeName}`;
      return indexedDbBackend(idb, dbName, storeName, keyPath);
    }
  } catch {
    /* fall through to memory */
  }
  return memoryBackend();
}

export interface ProviderKeyInfo {
  id: string;
  name: string;
  configured: boolean;
  updatedAt: string | null;
}

export interface EphemeralKeyStore {
  list(): Promise<ProviderKeyInfo[]>;
  getToken(id: string): Promise<string>;
  setToken(id: string, token: string): Promise<void>;
  remove(id: string): Promise<void>;
}

export function createEphemeralKeyStore(backend: KvBackend = defaultBackend("provider-keys", "provider")): EphemeralKeyStore {
  return {
    async list() {
      let stored: any[];
      try {
        stored = await backend.getAll();
      } catch {
        stored = [];
      }
      const byId = new Map(stored.map((r) => [r.provider, r]));
      return EPHEMERAL_PROVIDERS.map((p) => {
        const rec = byId.get(p.id);
        return { id: p.id, name: p.name, configured: Boolean(rec && rec.token), updatedAt: rec ? rec.updatedAt : null };
      });
    },
    async getToken(id) {
      const entry = ephemeralCatalogEntry(id);
      if (!entry) return "";
      let stored: any[];
      try {
        stored = await backend.getAll();
      } catch {
        return "";
      }
      const rec = stored.find((r) => r.provider === entry.id);
      return rec && rec.token ? rec.token : "";
    },
    async setToken(id, token) {
      const entry = ephemeralCatalogEntry(id);
      if (!entry) throw new Error(`Unknown ephemeral provider: ${id}`);
      const value = String(token || "").trim();
      if (!value) throw new Error("API token cannot be empty");
      await backend.put(entry.id, { provider: entry.id, token: value, updatedAt: nowIso() });
    },
    async remove(id) {
      const entry = ephemeralCatalogEntry(id);
      if (!entry) return;
      await backend.delete(entry.id);
    },
  };
}

export type DeviceCredentialScope = "device" | "account";

export interface EphemeralModelKeyInfo {
  provider: string;
  configured: boolean;
  updatedAt: string | null;
  /** Account keys enter the E2E device vault; device keys never leave this PWA. */
  scope: DeviceCredentialScope;
}

export interface EphemeralModelKeyEntry {
  provider: string;
  key: string;
  updatedAt?: string | null;
  scope: DeviceCredentialScope;
}

/**
 * Device-local store for the model **API keys** used to seed a freshly-launched
 * ephemeral machine's vault over the paired E2E channel — closing the cold-start
 * gap where a first-ever node has no peer to sync the model-auth vault from (see
 * docs/ephemeral-sessions.md, "Closing the cold-start gap").
 *
 * Same privacy model as the cloud provider tokens above: IndexedDB on THIS
 * device, never sent to the control plane, never baked into user-data. Keyed by
 * model-provider id (e.g. "anthropic", "openai") — an opaque, lower-cased string
 * this store doesn't validate, since the model-provider set is open-ended and
 * lives on the node, not here. API keys only; agent-native OAuth logins are out
 * of scope (fragile to replay onto disposable machines — see credential-sync.md).
 */
export interface EphemeralModelKeyStore {
  /** Metadata for the UI — provider id + whether a key is saved. No secrets. */
  list(): Promise<EphemeralModelKeyInfo[]>;
  /** The stored keys, for seeding a node. Secrets — never surface in the UI. */
  entries(): Promise<EphemeralModelKeyEntry[]>;
  get(provider: string): Promise<string>;
  set(provider: string, key: string, scope?: DeviceCredentialScope): Promise<void>;
  remove(provider: string): Promise<void>;
}

export function createEphemeralModelKeyStore(
  backend: KvBackend = defaultBackend("model-keys", "provider"),
): EphemeralModelKeyStore {
  const norm = (p: string) => String(p || "").trim().toLowerCase();
  const all = async (): Promise<any[]> => {
    try {
      return await backend.getAll();
    } catch {
      return [];
    }
  };
  return {
    async list() {
      const stored = await all();
      return stored
        .filter((r) => r && r.provider)
        .map((r) => ({
          provider: String(r.provider),
          configured: Boolean(r.key),
          updatedAt: r.updatedAt ?? null,
          // Existing ephemeral seed keys become account keys: this preserves their
          // old purpose (making a newly-created node usable) while moving them to
          // the unified account vault.
          scope: r.scope === "device" ? "device" as const : "account" as const,
        }))
        .sort((a, b) => a.provider.localeCompare(b.provider));
    },
    async entries() {
      const stored = await all();
      return stored
        .filter((r) => r && r.provider && r.key)
        .map((r) => ({
          provider: String(r.provider),
          key: String(r.key),
          updatedAt: r.updatedAt ?? null,
          scope: r.scope === "device" ? "device" as const : "account" as const,
        }));
    },
    async get(provider) {
      const id = norm(provider);
      if (!id) return "";
      const rec = (await all()).find((r) => r.provider === id);
      return rec && rec.key ? rec.key : "";
    },
    async set(provider, key, scope = "account") {
      const id = norm(provider);
      if (!id) throw new Error("Provider is required");
      const value = String(key || "").trim();
      if (!value) throw new Error("API key cannot be empty");
      if (scope !== "account" && scope !== "device") throw new Error("Credential scope must be account or device");
      await backend.put(id, { provider: id, key: value, scope, updatedAt: nowIso() });
    },
    async remove(provider) {
      const id = norm(provider);
      if (!id) return;
      await backend.delete(id);
    },
  };
}

/**
 * Device-local store for the GitHub token an ephemeral node uses to run
 * queued issue work (issue #532) — same privacy model as the provider keys
 * above (IndexedDB on this device; never sent to the control plane), but a
 * single value rather than one per provider, since it's not provider-specific.
 * Optional: queue items still dispatch to an ephemeral server without one, they
 * just can't authenticate to GitHub once there (clone/push/PR all fail).
 */
export interface GithubTaskTokenStore {
  get(): Promise<string>;
  set(token: string): Promise<void>;
  remove(): Promise<void>;
}

const GITHUB_TASK_TOKEN_KEY = "github-task-token";

export function createGithubTaskTokenStore(backend: KvBackend = defaultBackend("github-task-token", "id")): GithubTaskTokenStore {
  return {
    async get() {
      let stored: any[];
      try {
        stored = await backend.getAll();
      } catch {
        return "";
      }
      const rec = stored.find((r) => r.id === GITHUB_TASK_TOKEN_KEY);
      return rec && rec.token ? rec.token : "";
    },
    async set(token) {
      const value = String(token || "").trim();
      if (!value) throw new Error("GitHub token cannot be empty");
      await backend.put(GITHUB_TASK_TOKEN_KEY, { id: GITHUB_TASK_TOKEN_KEY, token: value, updatedAt: nowIso() });
    },
    async remove() {
      await backend.delete(GITHUB_TASK_TOKEN_KEY);
    },
  };
}

/**
 * Device-local, per-provider launch preferences (issue: "Ephemeral machines"
 * Settings screen). These are the saved defaults a user configures once — region,
 * server size, auto-destroy TTL, and an optional repo — so the new-session launch
 * flow can pre-fill them instead of asking from scratch every time. Same privacy
 * model as the provider tokens (IndexedDB on this device; never sent to the
 * control plane). A `null` field means "no preference — fall back to the
 * provider adapter's default".
 */
export interface EphemeralPrefs {
  region: string | null;
  size: string | null;
  ttlMinutes: number | null;
  repo: string | null;
  /** Ask the launching device to destroy the provider machine after agent_end.
   * TTL remains a safety fallback if that device is no longer online. */
  teardownOnAgentFinish: boolean;
}

export interface EphemeralPrefsStore {
  get(id: string): Promise<EphemeralPrefs>;
  set(id: string, patch: Partial<EphemeralPrefs>): Promise<EphemeralPrefs>;
  remove(id: string): Promise<void>;
}

/** A reusable ephemeral node definition. Unlike a running machine, a setup is
 * device-local configuration and remains available after its machine expires. */
export interface EphemeralSetup extends EphemeralPrefs {
  id: string;
  provider: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface EphemeralSetupStore {
  list(provider?: string): Promise<EphemeralSetup[]>;
  get(id: string): Promise<EphemeralSetup | null>;
  create(provider: string, input: { name: string } & Partial<EphemeralPrefs>): Promise<EphemeralSetup>;
  update(id: string, patch: Partial<Pick<EphemeralSetup, "name" | keyof EphemeralPrefs>>): Promise<EphemeralSetup>;
  remove(id: string): Promise<void>;
}

const EMPTY_PREFS: EphemeralPrefs = { region: null, size: null, ttlMinutes: null, repo: null, teardownOnAgentFinish: false };

export function createEphemeralPrefsStore(
  backend: KvBackend = defaultBackend("provider-prefs", "provider"),
): EphemeralPrefsStore {
  const read = async (id: string): Promise<EphemeralPrefs> => {
    const entry = ephemeralCatalogEntry(id);
    if (!entry) return { ...EMPTY_PREFS };
    let stored: any[];
    try {
      stored = await backend.getAll();
    } catch {
      return { ...EMPTY_PREFS };
    }
    const rec = stored.find((r) => r.provider === entry.id);
    if (!rec) return { ...EMPTY_PREFS };
    return {
      region: rec.region ?? null,
      size: rec.size ?? null,
      ttlMinutes: typeof rec.ttlMinutes === "number" ? rec.ttlMinutes : null,
      repo: rec.repo ?? null,
      teardownOnAgentFinish: rec.teardownOnAgentFinish === true,
    };
  };
  return {
    get: read,
    async set(id, patch) {
      const entry = ephemeralCatalogEntry(id);
      if (!entry) throw new Error(`Unknown ephemeral provider: ${id}`);
      const current = await read(entry.id);
      const next: EphemeralPrefs = { ...current, ...patch };
      await backend.put(entry.id, { provider: entry.id, ...next, updatedAt: nowIso() });
      return next;
    },
    async remove(id) {
      const entry = ephemeralCatalogEntry(id);
      if (!entry) return;
      await backend.delete(entry.id);
    },
  };
}

function setupId(): string {
  try {
    return "setup-" + randHex(8);
  } catch {
    return `setup-${Math.random().toString(16).slice(2)}`;
  }
}

/** Multiple named configurations may be saved for the same cloud provider.
 * They intentionally live in a new store so the old per-provider defaults can
 * continue to pre-fill ad-hoc launches and existing users lose no settings. */
export function createEphemeralSetupStore(
  backend: KvBackend = defaultBackend("setups", "id"),
): EphemeralSetupStore {
  const all = async (): Promise<EphemeralSetup[]> => {
    try {
      return (await backend.getAll())
        .filter((r) => r && r.id && ephemeralCatalogEntry(r.provider))
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    } catch {
      return [];
    }
  };
  return {
    async list(provider) {
      const rows = await all();
      if (!provider) return rows;
      const entry = ephemeralCatalogEntry(provider);
      return entry ? rows.filter((r) => r.provider === entry.id) : [];
    },
    async get(id) {
      return (await all()).find((r) => r.id === id) ?? null;
    },
    async create(provider, input) {
      const entry = ephemeralCatalogEntry(provider);
      if (!entry) throw new Error(`Unknown ephemeral provider: ${provider}`);
      const name = String(input.name || "").trim();
      if (!name) throw new Error("Setup name is required");
      const now = nowIso();
      const setup: EphemeralSetup = {
        id: setupId(), provider: entry.id, name, ...EMPTY_PREFS,
        region: input.region ?? null, size: input.size ?? null,
        ttlMinutes: input.ttlMinutes ?? null, repo: input.repo ?? null,
        teardownOnAgentFinish: input.teardownOnAgentFinish === true,
        createdAt: now, updatedAt: now,
      };
      await backend.put(setup.id, setup);
      return setup;
    },
    async update(id, patch) {
      const current = (await all()).find((r) => r.id === id);
      if (!current) throw new Error("Ephemeral setup not found");
      const next = { ...current, ...patch, id: current.id, provider: current.provider, updatedAt: nowIso() };
      next.name = String(next.name || "").trim();
      if (!next.name) throw new Error("Setup name is required");
      await backend.put(id, next);
      return next;
    },
    async remove(id) {
      await backend.delete(id);
    },
  };
}

/** Device-local durable intent for a first message waiting on an ephemeral
 * runner. Prompt content stays on the user's device; the control plane only
 * receives it later through the normal encrypted relay. */
export interface PendingEphemeralLaunch {
  id: string;
  config: EphemeralNodeConfig;
  prompt: {
    text: string;
    requestId: string;
    clientMessageId: string;
    attachments?: PromptAttachment[];
    frame: Command;
  };
  followups: Array<{ text: string; clientMessageId: string; attachments?: PromptAttachment[] }>;
  logs: string[];
  phase: "provisioning" | "booting" | "failed";
  machine?: EphemeralMachine;
  createdAt: string;
  updatedAt: string;
}

export interface PendingEphemeralLaunchStore {
  list(): Promise<PendingEphemeralLaunch[]>;
  put(launch: PendingEphemeralLaunch): Promise<void>;
  remove(id: string): Promise<void>;
}

export function createPendingEphemeralLaunchStore(
  backend: KvBackend = defaultBackend("pending-launches", "id"),
): PendingEphemeralLaunchStore {
  return {
    async list() {
      try {
        return (await backend.getAll())
          .filter((r) => r && r.id && r.config && r.prompt)
          .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))) as PendingEphemeralLaunch[];
      } catch {
        return [];
      }
    },
    async put(launch) {
      await backend.put(launch.id, launch);
    },
    async remove(id) {
      await backend.delete(id);
    },
  };
}

export interface MachineStore {
  list(): Promise<EphemeralMachine[]>;
  add(machine: EphemeralMachine): Promise<EphemeralMachine>;
  update(id: string, patch: Partial<EphemeralMachine>): Promise<EphemeralMachine | null>;
  remove(id: string): Promise<void>;
}

export function createMachineStore(backend: KvBackend = defaultBackend("machines", "id")): MachineStore {
  return {
    async list() {
      try {
        return (await backend.getAll()).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      } catch {
        return [];
      }
    },
    async add(machine) {
      if (!machine || !machine.id) throw new Error("Machine record needs an id");
      await backend.put(machine.id, machine);
      return machine;
    },
    async update(id, patch) {
      const all = await backend.getAll().catch(() => []);
      const existing = all.find((m) => m.id === id);
      if (!existing) return null;
      const merged = { ...existing, ...patch };
      await backend.put(id, merged);
      return merged;
    },
    async remove(id) {
      await backend.delete(id);
    },
  };
}
