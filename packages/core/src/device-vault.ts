// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Opt-in E2E "device vault" for ephemeral provider tokens (P2 / Gap A in
// docs/ephemeral-sessions.md). The provider token a device saves to launch an
// ephemeral machine lives only in that device's IndexedDB, so a SECOND account
// device can't wake/reach the machine (`wakeEphemeralMachine` → getToken → "").
//
// This syncs the tokens to the account's other paired devices through the
// control plane WITHOUT the control plane ever seeing a token: the tokens map is
// sealed under a per-account 32-byte vault key, and the vault key is ECDH-wrapped
// to each device's X25519 public key (mirrors the node model-auth vault, but the
// recipients are DEVICES). The CP stores only ciphertext + per-device wrapped
// keys — the exact "no-secrets" posture in CLOUD.md.
//
// A `DeviceVaultKeyStore` is a drop-in `EphemeralKeyStore`: it reads local first
// and falls through to the synced tokens, so every existing call site
// (launch/wake/destroy) works unchanged, and single-device / opt-out users are
// unaffected.
import { seal, open, importRoomKey } from "./crypto.js";
import { wrapKeyFor, type DeviceKeypair } from "./pairing.js";
import { b64, unb64 } from "./base64.js";
import type {
  DeviceCredentialScope,
  EphemeralKeyStore,
  EphemeralModelKeyEntry,
  EphemeralModelKeyInfo,
  EphemeralModelKeyStore,
  ProviderKeyInfo,
} from "./ephemeral.js";

/** One device's ECDH-wrapped copy of the account vault key. */
export interface DeviceVaultWrappedKey {
  /** seal(wrapKeyFor(producerPriv, thisDevicePub, "device-vault"), vaultKeyB64) */
  wrappedKey: string;
  /** The producer device's X25519 public key — the ECDH counterpart to unwrap. */
  wrappedByPublicKeyB64: string;
}

export interface DeviceVaultSnapshot {
  /** Sealed tokens-map ciphertext, or null when no producer has written yet. */
  vault: string | null;
  /** This device's wrapped vault key, or null until a producer wraps for it. */
  wrappedKey: DeviceVaultWrappedKey | null;
  /** Other devices' public keys that have requested a wrapped key. */
  requests: string[];
}

/** Control-plane transport for the device vault. Ciphertext + wrapped keys only
 *  — the CP never sees a token or the vault key in the clear. Fetch-backed in
 *  the app; a fake in tests. */
export interface DeviceVaultRemote {
  get(): Promise<DeviceVaultSnapshot>;
  putVault(ciphertext: string): Promise<void>;
  requestKey(): Promise<void>;
  putWrapped(targetDevicePublicKeyB64: string, wrappedKey: string, wrappedByPublicKeyB64: string): Promise<void>;
}

export interface DeviceVaultDeps {
  /** The device-local IndexedDB provider-key store — source of truth on this
   *  device and the fallthrough when the vault is off/empty. */
  local: EphemeralKeyStore;
  /** The control-plane transport. */
  remote: DeviceVaultRemote;
  /** This device's X25519 keypair (`deviceKeypair()` in the app). */
  device: () => Promise<DeviceKeypair>;
  /** Account-vault gate. Normally true for a signed-in PWA, including a user
   *  who has no node yet. When false every credential remains device-local. */
  enabled: () => boolean;
  /** Compute-provider tokens have a wider billing permission and remain opt-in. */
  providerTokenSyncEnabled?: () => boolean;
  /** Device model/voice key storage. Account-scoped entries are synchronized. */
  modelKeys?: EphemeralModelKeyStore;
  /** Injectable RNG for the vault key (tests). */
  randomKey?: () => Uint8Array;
}

export interface DeviceVaultKeyStore extends EphemeralKeyStore {
  /** Reconcile with the control plane: consume a wrapped key, or (if this device
   *  holds credentials) become/refresh the producer and satisfy peers' requests. */
  sync(): Promise<void>;
  listModelKeys(): Promise<EphemeralModelKeyInfo[]>;
  modelKeyEntries(): Promise<EphemeralModelKeyEntry[]>;
  getModelKey(provider: string): Promise<string>;
  setModelKey(provider: string, key: string, scope?: DeviceCredentialScope): Promise<void>;
  removeModelKey(provider: string): Promise<void>;
  /** Merge account-scoped API keys exported by an enrolled node. */
  importModelKeys(entries: Array<{ provider: string; key: string }>): Promise<void>;
}

type TokenMap = Record<string, string>;
type ModelKeyMap = Record<string, { key: string; updatedAt?: string | null }>;
type DeviceVaultPayload = { v: 2; providerTokens: TokenMap; modelKeys: ModelKeyMap };

function normalizePayload(parsed: unknown): DeviceVaultPayload {
  if (parsed && typeof parsed === "object" && (parsed as { v?: unknown }).v === 2) {
    const value = parsed as Partial<DeviceVaultPayload>;
    return {
      v: 2,
      providerTokens: value.providerTokens && typeof value.providerTokens === "object" ? value.providerTokens : {},
      modelKeys: value.modelKeys && typeof value.modelKeys === "object" ? value.modelKeys : {},
    };
  }
  // v1 was a bare compute-provider token map.
  return { v: 2, providerTokens: parsed && typeof parsed === "object" ? parsed as TokenMap : {}, modelKeys: {} };
}

function defaultRandomKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

/** A vault-backed EphemeralKeyStore. */
export function createDeviceVaultKeyStore(deps: DeviceVaultDeps): DeviceVaultKeyStore {
  const randomKey = deps.randomKey ?? defaultRandomKey;
  // In-memory caches, populated by sync().
  let vaultKey: Uint8Array | null = null;
  let remotePayload: DeviceVaultPayload = { v: 2, providerTokens: {}, modelKeys: {} };

  const sealVault = async (payload: DeviceVaultPayload, key: Uint8Array) => seal(await importRoomKey(key), JSON.stringify(payload));
  const openVault = async (ciphertext: string, key: Uint8Array): Promise<DeviceVaultPayload> => {
    const json = await open(await importRoomKey(key), ciphertext);
    return normalizePayload(JSON.parse(json));
  };
  // Wrap/unwrap the vault key TO/FROM a peer device via ECDH(this, peer).
  const wrapVaultKeyFor = async (dev: DeviceKeypair, peerPub: string, key: Uint8Array) =>
    seal(await wrapKeyFor(dev.priv, peerPub, "device-vault"), b64(key));
  const unwrapVaultKey = async (dev: DeviceKeypair, producerPub: string, wrapped: string) =>
    unb64(await open(await wrapKeyFor(dev.priv, producerPub, "device-vault"), wrapped));

  async function localTokenMap(): Promise<TokenMap> {
    const out: TokenMap = {};
    for (const info of await deps.local.list()) {
      const t = await deps.local.getToken(info.id);
      if (t) out[info.id] = t;
    }
    return out;
  }

  async function localModelKeyMap(): Promise<ModelKeyMap> {
    const out: ModelKeyMap = {};
    if (!deps.modelKeys) return out;
    for (const entry of await deps.modelKeys.entries()) {
      if (entry.scope === "account") out[entry.provider] = { key: entry.key, updatedAt: entry.updatedAt };
    }
    return out;
  }

  async function publish(): Promise<void> {
    if (!vaultKey) return;
    await deps.remote.putVault(await sealVault(remotePayload, vaultKey));
  }

  async function sync(): Promise<void> {
    if (!deps.enabled()) return;
    const dev = await deps.device();
    const snap = await deps.remote.get();

    // 1. Obtain the vault key: from cache, else unwrap our delivered copy.
    if (!vaultKey && snap.wrappedKey) {
      try {
        vaultKey = await unwrapVaultKey(dev, snap.wrappedKey.wrappedByPublicKeyB64, snap.wrappedKey.wrappedKey);
      } catch {
        /* stale/foreign wrap — ignore; we may re-request below */
      }
    }
    // 2. With the key + ciphertext, decrypt the synced token map (consumer side).
    if (vaultKey && snap.vault) {
      try {
        remotePayload = await openVault(snap.vault, vaultKey);
      } catch {
        /* corrupt/foreign ciphertext — leave prior cache */
      }
    }

    const localTokens = deps.providerTokenSyncEnabled?.() === false ? {} : await localTokenMap();
    const localModels = await localModelKeyMap();
    const haveLocal = Object.keys(localTokens).length > 0 || Object.keys(localModels).length > 0;

    if (haveLocal) {
      // Producer: ensure a key, publish the merged namespaced payload, self-wrap
      // for recovery, and satisfy every other device's outstanding request.
      if (!vaultKey) vaultKey = randomKey();
      remotePayload = {
        v: 2,
        providerTokens: { ...remotePayload.providerTokens, ...localTokens },
        modelKeys: { ...remotePayload.modelKeys, ...localModels },
      };
      await publish();
      await deps.remote.putWrapped(dev.pub, await wrapVaultKeyFor(dev, dev.pub, vaultKey), dev.pub);
      for (const reqPub of snap.requests) {
        if (reqPub === dev.pub) continue;
        await deps.remote.putWrapped(reqPub, await wrapVaultKeyFor(dev, reqPub, vaultKey), dev.pub);
      }
    } else if (!vaultKey) {
      // No local tokens and no key yet: ask a producer to wrap for us.
      await deps.remote.requestKey();
    }
  }

  return {
    sync,
    async getToken(id: string): Promise<string> {
      const local = await deps.local.getToken(id);
      if (local) return local;
      if (!deps.enabled()) return "";
      if (!(id in remotePayload.providerTokens)) {
        try {
          await sync();
        } catch {
          /* offline / not yet wrapped — fall through to whatever we have */
        }
      }
      return remotePayload.providerTokens[id] ?? "";
    },
    async setToken(id: string, token: string): Promise<void> {
      await deps.local.setToken(id, token);
      if (deps.enabled() && deps.providerTokenSyncEnabled?.() !== false) {
        try {
          await sync(); // republish as producer
        } catch {
          /* best effort; the local write already succeeded */
        }
      }
    },
    async remove(id: string): Promise<void> {
      await deps.local.remove(id);
      if (!deps.enabled()) return;
      delete remotePayload.providerTokens[id];
      if (vaultKey) {
        try {
          await publish();
        } catch {
          /* best effort */
        }
      }
    },
    async list(): Promise<ProviderKeyInfo[]> {
      const local = await deps.local.list();
      const seen = new Set(local.map((i) => i.id));
      const merged = [...local];
      if (deps.providerTokenSyncEnabled?.() !== false) {
        for (const id of Object.keys(remotePayload.providerTokens)) {
          if (!seen.has(id)) merged.push({ id, name: id, configured: true, updatedAt: null });
        }
      }
      return merged;
    },
    async listModelKeys() {
      const local = await deps.modelKeys?.list() ?? [];
      const seen = new Set(local.map((entry) => entry.provider));
      const merged = [...local];
      for (const [provider, entry] of Object.entries(remotePayload.modelKeys)) {
        if (!seen.has(provider)) merged.push({ provider, configured: true, updatedAt: entry.updatedAt ?? null, scope: "account" });
      }
      return merged.sort((a, b) => a.provider.localeCompare(b.provider));
    },
    async modelKeyEntries() {
      const local = await deps.modelKeys?.entries() ?? [];
      const byProvider = new Map(local.map((entry) => [entry.provider, entry]));
      for (const [provider, entry] of Object.entries(remotePayload.modelKeys)) {
        if (!byProvider.has(provider)) byProvider.set(provider, { provider, key: entry.key, updatedAt: entry.updatedAt, scope: "account" });
      }
      return [...byProvider.values()];
    },
    async getModelKey(provider) {
      const id = String(provider || "").trim().toLowerCase();
      const local = await deps.modelKeys?.get(id) ?? "";
      if (local) return local;
      if (deps.enabled() && !(id in remotePayload.modelKeys)) await sync().catch(() => {});
      return remotePayload.modelKeys[id]?.key ?? "";
    },
    async setModelKey(provider, key, scope = "account") {
      if (!deps.modelKeys) throw new Error("Device model-key storage is unavailable");
      await deps.modelKeys.set(provider, key, scope);
      if (scope === "device") {
        delete remotePayload.modelKeys[String(provider).trim().toLowerCase()];
        await publish().catch(() => {});
      } else if (deps.enabled()) await sync().catch(() => {});
    },
    async removeModelKey(provider) {
      const id = String(provider || "").trim().toLowerCase();
      await deps.modelKeys?.remove(id);
      delete remotePayload.modelKeys[id];
      await publish().catch(() => {});
    },
    async importModelKeys(entries) {
      if (!deps.modelKeys) return;
      for (const entry of entries) await deps.modelKeys.set(entry.provider, entry.key, "account");
      if (deps.enabled()) await sync().catch(() => {});
    },
  };
}
