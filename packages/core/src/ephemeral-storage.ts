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
  /** Human account name. `default` stays implicit in the single-key path. */
  label: string;
  configured: boolean;
  updatedAt: string | null;
  /** Account keys enter the E2E device vault; device keys never leave this PWA. */
  scope: DeviceCredentialScope;
}

export interface EphemeralModelKeyEntry {
  provider: string;
  label: string;
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
export interface DeviceOAuthCredential {
  provider: string;
  label: string;
  access: string;
  refresh: string;
  expires: number;
  refreshedAt?: number;
  updatedAt?: number;
}

/** Browser-held recovery copies of Bivy-managed OAuth records. These records
 * are encrypted by the E2E device vault and are never used to refresh in the
 * browser; a node remains the only OAuth actor. */
export interface DeviceOAuthCredentialStore {
  entries(): Promise<DeviceOAuthCredential[]>;
  set(entry: DeviceOAuthCredential): Promise<void>;
  remove(provider: string, label?: string): Promise<void>;
}

export function createDeviceOAuthCredentialStore(
  backend: KvBackend = defaultBackend("model-oauth", "id"),
): DeviceOAuthCredentialStore {
  const norm = (value: string) => String(value || "").trim().toLowerCase();
  const label = (value?: string) => norm(value || "default") || "default";
  const id = (provider: string, account: string) => `${provider}:${account}`;
  const all = async (): Promise<any[]> => { try { return await backend.getAll(); } catch { return []; } };
  return {
    async entries() {
      return (await all()).filter((entry) => entry?.provider && entry?.refresh).map((entry) => ({
        provider: norm(entry.provider), label: label(entry.label), access: String(entry.access || ""),
        refresh: String(entry.refresh), expires: Number(entry.expires) || 0,
        ...(Number.isFinite(Number(entry.refreshedAt)) ? { refreshedAt: Number(entry.refreshedAt) } : {}),
        ...(Number.isFinite(Number(entry.updatedAt)) ? { updatedAt: Number(entry.updatedAt) } : {}),
      }));
    },
    async set(entry) {
      const provider = norm(entry.provider); const account = label(entry.label);
      if (!provider || !String(entry.refresh || "").trim()) throw new Error("A provider and refresh token are required");
      await backend.put(id(provider, account), { ...entry, id: id(provider, account), provider, label: account });
    },
    async remove(provider, account = "default") { await backend.delete(id(norm(provider), label(account))); },
  };
}

export interface EphemeralModelKeyStore {
  /** Metadata for the UI — provider id + whether a key is saved. No secrets. */
  list(): Promise<EphemeralModelKeyInfo[]>;
  /** The stored keys, for seeding a node. Secrets — never surface in the UI. */
  entries(): Promise<EphemeralModelKeyEntry[]>;
  get(provider: string, label?: string): Promise<string>;
  set(provider: string, key: string, scope?: DeviceCredentialScope, label?: string): Promise<void>;
  remove(provider: string, label?: string): Promise<void>;
}

export function createEphemeralModelKeyStore(
  backend: KvBackend = defaultBackend("model-keys", "provider"),
): EphemeralModelKeyStore {
  const norm = (p: string) => String(p || "").trim().toLowerCase();
  const normLabel = (label?: string) => String(label || "default").trim().toLowerCase() || "default";
  // Preserve the legacy IndexedDB key for defaults; labeled accounts use a
  // collision-free composite key and therefore need no destructive migration.
  const recordId = (provider: string, label: string) => label === "default" ? provider : `${provider}:${label}`;
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
          label: normLabel(r.label),
          configured: Boolean(r.key),
          updatedAt: r.updatedAt ?? null,
          // Existing ephemeral seed keys become account keys: this preserves their
          // old purpose (making a newly-created node usable) while moving them to
          // the unified account vault.
          scope: r.scope === "device" ? "device" as const : "account" as const,
        }))
        .sort((a, b) => a.provider.localeCompare(b.provider) || a.label.localeCompare(b.label));
    },
    async entries() {
      const stored = await all();
      return stored
        .filter((r) => r && r.provider && r.key)
        .map((r) => ({
          provider: String(r.provider),
          label: normLabel(r.label),
          key: String(r.key),
          updatedAt: r.updatedAt ?? null,
          scope: r.scope === "device" ? "device" as const : "account" as const,
        }));
    },
    async get(provider, label = "default") {
      const id = norm(provider);
      const account = normLabel(label);
      if (!id) return "";
      const rec = (await all()).find((r) => r.provider === id && normLabel(r.label) === account);
      return rec && rec.key ? rec.key : "";
    },
    async set(provider, key, scope = "account", label = "default") {
      const id = norm(provider);
      const account = normLabel(label);
      if (!id) throw new Error("Provider is required");
      const value = String(key || "").trim();
      if (!value) throw new Error("API key cannot be empty");
      if (scope !== "account" && scope !== "device") throw new Error("Credential scope must be account or device");
      await backend.put(recordId(id, account), { provider: id, label: account, key: value, scope, updatedAt: nowIso() });
    },
    async remove(provider, label = "default") {
      const id = norm(provider);
      if (!id) return;
      await backend.delete(recordId(id, normLabel(label)));
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
      // Controllers also hold live transports/retry state on the in-memory task.
      // Persist only the durable receipt; functions/sockets cannot be cloned by
      // IndexedDB and transport internals must not enter the saved launch.
      const { id, config, prompt, followups, logs, phase, machine, createdAt, updatedAt } = launch;
      await backend.put(id, { id, config, prompt, followups, logs, phase, machine, createdAt, updatedAt });
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
