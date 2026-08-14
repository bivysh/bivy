// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// E2E device credential vault with per-record, tombstone-based convergence.
import { seal, open, importRoomKey } from "./crypto.js";
import { wrapKeyFor, type DeviceKeypair } from "./pairing.js";
import { b64, unb64 } from "./base64.js";
import type {
  DeviceCredentialScope,
  EphemeralKeyStore,
  EphemeralModelKeyEntry,
  EphemeralModelKeyInfo,
  EphemeralModelKeyStore,
} from "./ephemeral.js";

export interface DeviceVaultWrappedKey {
  wrappedKey: string;
  wrappedByPublicKeyB64: string;
  /** Vault-key generation this wrap opens. Missing on legacy wraps. */
  generation?: number;
}

export interface DeviceVaultSnapshot {
  vault: string | null;
  wrappedKey: DeviceVaultWrappedKey | null;
  requests: string[];
  /** Optimistic ciphertext revision. Legacy servers default to zero. */
  generation?: number;
  /** Key epoch. Incremented when a paired device is revoked. */
  keyGeneration?: number;
  /** Current paired-device public keys; used to rewrap after revocation. */
  recipients?: string[];
}

export class DeviceVaultConflictError extends Error {
  constructor() { super("Device vault changed concurrently"); this.name = "DeviceVaultConflictError"; }
}

export interface DeviceVaultRemote {
  get(): Promise<DeviceVaultSnapshot>;
  putVault(ciphertext: string, expectedGeneration?: number, keyGeneration?: number): Promise<{ generation: number } | void>;
  requestKey(): Promise<void>;
  putWrapped(targetDevicePublicKeyB64: string, wrappedKey: string, wrappedByPublicKeyB64: string, generation?: number): Promise<void>;
}

export type DeviceVaultSyncPhase = "idle" | "pending" | "synced" | "failed";
export interface DeviceVaultSyncState {
  phase: DeviceVaultSyncPhase;
  attemptedAt: string | null;
  succeededAt: string | null;
  pending: boolean;
  failure: string | null;
}

/** Non-secret durable metadata. Implementations may use IndexedDB/localStorage. */
export interface DeviceVaultStateStore {
  load(): Promise<{ clock?: number; tokenVersions?: Record<string, number>; modelVersions?: Record<string, number>; tokenTombstones?: Record<string, number>; modelTombstones?: Record<string, number>; sync?: DeviceVaultSyncState } | undefined>;
  save(state: { clock: number; tokenVersions: Record<string, number>; modelVersions: Record<string, number>; tokenTombstones: Record<string, number>; modelTombstones: Record<string, number>; sync: DeviceVaultSyncState }): Promise<void>;
}

export interface DeviceVaultDeps {
  local: EphemeralKeyStore;
  remote: DeviceVaultRemote;
  device: () => Promise<DeviceKeypair>;
  enabled: () => boolean;
  providerTokenSyncEnabled?: () => boolean;
  modelKeys?: EphemeralModelKeyStore;
  randomKey?: () => Uint8Array;
  state?: DeviceVaultStateStore;
  now?: () => number;
}

export interface DeviceVaultKeyStore extends EphemeralKeyStore {
  sync(): Promise<void>;
  getSyncState(): DeviceVaultSyncState;
  listModelKeys(): Promise<EphemeralModelKeyInfo[]>;
  modelKeyEntries(): Promise<EphemeralModelKeyEntry[]>;
  getModelKey(provider: string): Promise<string>;
  setModelKey(provider: string, key: string, scope?: DeviceCredentialScope, label?: string): Promise<void>;
  removeModelKey(provider: string, label?: string): Promise<void>;
  importModelKeys(entries: Array<{ provider: string; label?: string; key: string }>): Promise<void>;
}

type VersionedRecord<T> = { value: T | null; updatedAt: number; tombstone?: true };
type DeviceVaultPayload = {
  v: 3;
  providerTokens: Record<string, VersionedRecord<string>>;
  modelKeys: Record<string, VersionedRecord<{ provider: string; label: string; key: string }>>;
};
type LegacyV2 = { v: 2; providerTokens?: Record<string, string>; modelKeys?: Record<string, { key: string; updatedAt?: string | null }> };

const emptyPayload = (): DeviceVaultPayload => ({ v: 3, providerTokens: {}, modelKeys: {} });
const emptySync = (): DeviceVaultSyncState => ({ phase: "idle", attemptedAt: null, succeededAt: null, pending: false, failure: null });
const stamp = (value: string | null | undefined): number => {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
};

function normalizePayload(parsed: unknown): DeviceVaultPayload {
  if (parsed && typeof parsed === "object" && (parsed as { v?: unknown }).v === 3) {
    const p = parsed as Partial<DeviceVaultPayload>;
    const modelKeys: DeviceVaultPayload["modelKeys"] = {};
    for (const [id, record] of Object.entries(p.modelKeys && typeof p.modelKeys === "object" ? p.modelKeys : {})) {
      if (!record || typeof record !== "object") continue;
      const rec = record as VersionedRecord<{ provider?: string; label?: string; key: string }>;
      modelKeys[id] = rec.value
        ? { ...rec, value: { provider: rec.value.provider || id.split(":")[0] || id, label: rec.value.label || id.split(":").slice(1).join(":") || "default", key: rec.value.key } }
        : rec as VersionedRecord<{ provider: string; label: string; key: string }>;
    }
    return { v: 3, providerTokens: p.providerTokens && typeof p.providerTokens === "object" ? p.providerTokens : {}, modelKeys };
  }
  const migrated = emptyPayload();
  const now = Date.now();
  if (parsed && typeof parsed === "object" && (parsed as { v?: unknown }).v === 2) {
    const p = parsed as LegacyV2;
    for (const [id, value] of Object.entries(p.providerTokens ?? {})) if (typeof value === "string") migrated.providerTokens[id] = { value, updatedAt: now };
    for (const [id, value] of Object.entries(p.modelKeys ?? {})) if (value && typeof value.key === "string") migrated.modelKeys[id] = { value: { provider: id, label: "default", key: value.key }, updatedAt: stamp(value.updatedAt) || now };
  } else if (parsed && typeof parsed === "object") {
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) if (typeof value === "string") migrated.providerTokens[id] = { value, updatedAt: now };
  }
  return migrated;
}

function choose<T>(a: VersionedRecord<T> | undefined, b: VersionedRecord<T> | undefined): VersionedRecord<T> | undefined {
  if (!a) return b;
  if (!b) return a;
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
  if (Boolean(a.tombstone) !== Boolean(b.tombstone)) return a.tombstone ? a : b; // deletes win exact ties
  return JSON.stringify(a.value) >= JSON.stringify(b.value) ? a : b; // deterministic clock-collision tie-break
}

function mergePayload(a: DeviceVaultPayload, b: DeviceVaultPayload): DeviceVaultPayload {
  const out = emptyPayload();
  for (const id of new Set([...Object.keys(a.providerTokens), ...Object.keys(b.providerTokens)])) out.providerTokens[id] = choose(a.providerTokens[id], b.providerTokens[id])!;
  for (const id of new Set([...Object.keys(a.modelKeys), ...Object.keys(b.modelKeys)])) out.modelKeys[id] = choose(a.modelKeys[id], b.modelKeys[id])!;
  return out;
}

function modelRecordId(provider: string, label = "default"): string {
  const p = String(provider || "").trim().toLowerCase();
  const l = String(label || "default").trim().toLowerCase() || "default";
  return l === "default" ? p : `${p}:${l}`;
}

function defaultRandomKey(): Uint8Array { return crypto.getRandomValues(new Uint8Array(32)); }

export function createDeviceVaultKeyStore(deps: DeviceVaultDeps): DeviceVaultKeyStore {
  const randomKey = deps.randomKey ?? defaultRandomKey;
  const now = deps.now ?? Date.now;
  let vaultKey: Uint8Array | null = null;
  let keyGeneration = 0;
  let generation = 0;
  let remotePayload = emptyPayload();
  let initialized: Promise<void> | null = null;
  let clock = 0;
  let tokenVersions: Record<string, number> = {};
  let modelVersions: Record<string, number> = {};
  let tokenTombstones: Record<string, number> = {};
  let modelTombstones: Record<string, number> = {};
  let syncState = emptySync();
  let inFlight: Promise<void> | null = null;

  const persist = async () => deps.state?.save({ clock, tokenVersions, modelVersions, tokenTombstones, modelTombstones, sync: syncState });
  const init = () => initialized ??= (async () => {
    const saved = await deps.state?.load();
    clock = Math.max(saved?.clock ?? 0, now());
    tokenVersions = { ...(saved?.tokenVersions ?? {}) };
    modelVersions = { ...(saved?.modelVersions ?? {}) };
    tokenTombstones = { ...(saved?.tokenTombstones ?? {}) };
    modelTombstones = { ...(saved?.modelTombstones ?? {}) };
    syncState = saved?.sync ?? emptySync();
  })();
  const nextStamp = () => (clock = Math.max(clock + 1, now()));
  const sealVault = async (payload: DeviceVaultPayload, key: Uint8Array) => seal(await importRoomKey(key), JSON.stringify(payload));
  const openVault = async (ciphertext: string, key: Uint8Array) => normalizePayload(JSON.parse(await open(await importRoomKey(key), ciphertext)));
  const wrapVaultKeyFor = async (dev: DeviceKeypair, peerPub: string, key: Uint8Array) => seal(await wrapKeyFor(dev.priv, peerPub, "device-vault"), b64(key));
  const unwrapVaultKey = async (dev: DeviceKeypair, producerPub: string, wrapped: string) => unb64(await open(await wrapKeyFor(dev.priv, producerPub, "device-vault"), wrapped));

  async function localPayload(): Promise<DeviceVaultPayload> {
    const out = emptyPayload();
    if (deps.providerTokenSyncEnabled?.() !== false) {
      for (const info of await deps.local.list()) {
        const value = await deps.local.getToken(info.id);
        if (value) out.providerTokens[info.id] = { value, updatedAt: Math.max(stamp(info.updatedAt), tokenVersions[info.id] ?? 1) };
      }
    }
    for (const [id, updatedAt] of Object.entries(tokenTombstones)) out.providerTokens[id] = choose(out.providerTokens[id], { value: null, updatedAt, tombstone: true })!;
    if (deps.modelKeys) {
      for (const entry of await deps.modelKeys.entries()) if (entry.scope === "account") {
        const id = modelRecordId(entry.provider, entry.label);
        out.modelKeys[id] = { value: { provider: entry.provider, label: entry.label, key: entry.key }, updatedAt: Math.max(stamp(entry.updatedAt), modelVersions[id] ?? 1) };
      }
    }
    for (const [id, updatedAt] of Object.entries(modelTombstones)) out.modelKeys[id] = choose(out.modelKeys[id], { value: null, updatedAt, tombstone: true })!;
    return out;
  }

  async function applyWinners(payload: DeviceVaultPayload): Promise<void> {
    for (const [id, rec] of Object.entries(payload.providerTokens)) {
      const localInfo = (await deps.local.list()).find((v) => v.id === id);
      const localStamp = stamp(localInfo?.updatedAt);
      if (rec.tombstone) {
        tokenTombstones[id] = Math.max(tokenTombstones[id] ?? 0, rec.updatedAt);
        if (localStamp <= rec.updatedAt) await deps.local.remove(id);
      } else if (rec.value && (!localInfo?.configured || localStamp < rec.updatedAt)) {
        await deps.local.setToken(id, rec.value);
        tokenVersions[id] = rec.updatedAt;
        delete tokenTombstones[id];
      }
    }
    if (deps.modelKeys) for (const [id, rec] of Object.entries(payload.modelKeys)) {
      const provider = rec.value?.provider ?? id;
      const label = rec.value?.label ?? "default";
      const local = (await deps.modelKeys.list()).find((v) => v.provider === provider && v.label === label);
      const localStamp = stamp(local?.updatedAt);
      if (rec.tombstone) {
        modelTombstones[id] = Math.max(modelTombstones[id] ?? 0, rec.updatedAt);
        if (localStamp <= rec.updatedAt) await deps.modelKeys.remove(provider, label);
      } else if (rec.value && (!local?.configured || localStamp < rec.updatedAt)) {
        await deps.modelKeys.set(provider, rec.value.key, "account", label);
        modelVersions[id] = rec.updatedAt;
        delete modelTombstones[id];
      }
    }
  }

  async function syncOnce(): Promise<void> {
    if (!deps.enabled()) return;
    await init();
    const dev = await deps.device();
    const snap = await deps.remote.get();
    generation = snap.generation ?? 0;
    const serverKeyGeneration = snap.keyGeneration ?? 0;
    if ((!vaultKey || (snap.wrappedKey?.generation ?? 0) > keyGeneration) && snap.wrappedKey) {
      vaultKey = await unwrapVaultKey(dev, snap.wrappedKey.wrappedByPublicKeyB64, snap.wrappedKey.wrappedKey);
      keyGeneration = snap.wrappedKey.generation ?? serverKeyGeneration;
    }
    if (vaultKey && snap.vault) remotePayload = await openVault(snap.vault, vaultKey);

    // Revocation advances the key epoch. A survivor that can open the old vault
    // becomes the rotator; the revoked device is absent from recipients.
    if (vaultKey && serverKeyGeneration > keyGeneration) {
      vaultKey = randomKey();
      keyGeneration = serverKeyGeneration;
    }

    const local = await localPayload();
    const merged = mergePayload(remotePayload, local);
    const hasRecords = Object.keys(merged.providerTokens).length + Object.keys(merged.modelKeys).length > 0;
    if (!vaultKey) {
      if (!snap.vault && hasRecords) { vaultKey = randomKey(); keyGeneration = serverKeyGeneration; }
      else { await deps.remote.requestKey(); syncState = { ...syncState, phase: "pending", pending: true, failure: null }; await persist(); return; }
    }

    const changed = JSON.stringify(merged) !== JSON.stringify(remotePayload) || !snap.vault || serverKeyGeneration > (snap.wrappedKey?.generation ?? serverKeyGeneration);
    remotePayload = merged;
    if (changed) {
      const result = await deps.remote.putVault(await sealVault(remotePayload, vaultKey), generation, keyGeneration);
      generation = result?.generation ?? generation + 1;
    }
    const recipients = new Set([dev.pub, ...(snap.recipients ?? []), ...snap.requests]);
    for (const recipient of recipients) {
      await deps.remote.putWrapped(recipient, await wrapVaultKeyFor(dev, recipient, vaultKey), dev.pub, keyGeneration);
    }
    await applyWinners(remotePayload);
    syncState = { phase: "synced", attemptedAt: syncState.attemptedAt, succeededAt: new Date(now()).toISOString(), pending: false, failure: null };
    await persist();
  }

  async function sync(): Promise<void> {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      await init();
      syncState = { ...syncState, phase: "pending", attemptedAt: new Date(now()).toISOString(), pending: true, failure: null };
      await persist();
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          try { await syncOnce(); return; }
          catch (error) { if (!(error instanceof DeviceVaultConflictError) || attempt === 2) throw error; }
        }
      } catch (error) {
        syncState = { ...syncState, phase: "failed", pending: true, failure: error instanceof Error ? error.message : String(error) };
        await persist();
        throw error;
      }
    })().finally(() => { inFlight = null; });
    return inFlight;
  }

  return {
    sync,
    getSyncState: () => ({ ...syncState }),
    async getToken(id) { const local = await deps.local.getToken(id); if (local) return local; if (deps.enabled() && !remotePayload.providerTokens[id]) await sync(); const rec = remotePayload.providerTokens[id]; return rec && !rec.tombstone ? rec.value ?? "" : ""; },
    async setToken(id, token) { await init(); await deps.local.setToken(id, token); tokenVersions[id] = nextStamp(); delete tokenTombstones[id]; await persist(); if (deps.enabled() && deps.providerTokenSyncEnabled?.() !== false) await sync(); },
    async remove(id) { await init(); await deps.local.remove(id); tokenTombstones[id] = nextStamp(); await persist(); if (deps.enabled()) await sync(); },
    async list() {
      const local = await deps.local.list(); const seen = new Set(local.filter((v) => v.configured).map((v) => v.id)); const merged = [...local];
      if (deps.providerTokenSyncEnabled?.() !== false) for (const [id, rec] of Object.entries(remotePayload.providerTokens)) if (!rec.tombstone && rec.value && !seen.has(id)) merged.push({ id, name: id, configured: true, updatedAt: new Date(rec.updatedAt).toISOString() });
      return merged;
    },
    async listModelKeys() { const local = await deps.modelKeys?.list() ?? []; const seen = new Set(local.filter((v) => v.configured).map((v) => modelRecordId(v.provider, v.label))); for (const [id, rec] of Object.entries(remotePayload.modelKeys)) if (!rec.tombstone && rec.value && !seen.has(id)) local.push({ provider: rec.value.provider, label: rec.value.label, configured: true, updatedAt: new Date(rec.updatedAt).toISOString(), scope: "account" }); return local.sort((a, b) => a.provider.localeCompare(b.provider) || a.label.localeCompare(b.label)); },
    async modelKeyEntries() { const local = await deps.modelKeys?.entries() ?? []; const by = new Map(local.map((v) => [modelRecordId(v.provider, v.label), v])); for (const [id, rec] of Object.entries(remotePayload.modelKeys)) if (!rec.tombstone && rec.value && !by.has(id)) by.set(id, { provider: rec.value.provider, label: rec.value.label, key: rec.value.key, updatedAt: new Date(rec.updatedAt).toISOString(), scope: "account" }); return [...by.values()]; },
    async getModelKey(provider) { const id = modelRecordId(provider); const local = await deps.modelKeys?.get(provider) ?? ""; if (local) return local; if (deps.enabled() && !remotePayload.modelKeys[id]) await sync(); const rec = remotePayload.modelKeys[id]; return rec && !rec.tombstone ? rec.value?.key ?? "" : ""; },
    async setModelKey(provider, key, scope = "account", label = "default") { if (!deps.modelKeys) throw new Error("Device model-key storage is unavailable"); await init(); const id = modelRecordId(provider, label); await deps.modelKeys.set(provider, key, scope, label); if (scope === "device") modelTombstones[id] = nextStamp(); else { modelVersions[id] = nextStamp(); delete modelTombstones[id]; } await persist(); if (deps.enabled()) await sync(); },
    async removeModelKey(provider, label = "default") { await init(); const id = modelRecordId(provider, label); await deps.modelKeys?.remove(provider, label); modelTombstones[id] = nextStamp(); await persist(); if (deps.enabled()) await sync(); },
    async importModelKeys(entries) { if (!deps.modelKeys) return; await init(); for (const entry of entries) { const label = entry.label ?? "default"; const id = modelRecordId(entry.provider, label); await deps.modelKeys.set(entry.provider, entry.key, "account", label); modelVersions[id] = nextStamp(); delete modelTombstones[id]; } await persist(); if (deps.enabled()) await sync(); },
  };
}
