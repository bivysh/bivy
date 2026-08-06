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
import type { EphemeralKeyStore, ProviderKeyInfo } from "./ephemeral.js";

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
  /** Opt-in gate. When false the store is purely local (today's behavior). */
  enabled: () => boolean;
  /** Injectable RNG for the vault key (tests). */
  randomKey?: () => Uint8Array;
}

export interface DeviceVaultKeyStore extends EphemeralKeyStore {
  /** Reconcile with the control plane: consume a wrapped key, or (if this device
   *  holds tokens) become/refresh the producer and satisfy peers' requests. Safe
   *  to call on app open and after any token change. No-op when disabled. */
  sync(): Promise<void>;
}

type TokenMap = Record<string, string>;

function defaultRandomKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

/** A vault-backed EphemeralKeyStore. */
export function createDeviceVaultKeyStore(deps: DeviceVaultDeps): DeviceVaultKeyStore {
  const randomKey = deps.randomKey ?? defaultRandomKey;
  // In-memory caches, populated by sync().
  let vaultKey: Uint8Array | null = null;
  let remoteTokens: TokenMap = {};

  const sealVault = async (tokens: TokenMap, key: Uint8Array) => seal(await importRoomKey(key), JSON.stringify(tokens));
  const openVault = async (ciphertext: string, key: Uint8Array): Promise<TokenMap> => {
    const json = await open(await importRoomKey(key), ciphertext);
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === "object" ? (parsed as TokenMap) : {};
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
        remoteTokens = await openVault(snap.vault, vaultKey);
      } catch {
        /* corrupt/foreign ciphertext — leave prior cache */
      }
    }

    const localTokens = await localTokenMap();
    const haveLocal = Object.keys(localTokens).length > 0;

    if (haveLocal) {
      // Producer: ensure a key, publish the merged map, self-wrap for recovery,
      // and satisfy every other device's outstanding request.
      if (!vaultKey) vaultKey = randomKey();
      const merged: TokenMap = { ...remoteTokens, ...localTokens };
      remoteTokens = merged;
      await deps.remote.putVault(await sealVault(merged, vaultKey));
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
      if (!(id in remoteTokens)) {
        try {
          await sync();
        } catch {
          /* offline / not yet wrapped — fall through to whatever we have */
        }
      }
      return remoteTokens[id] ?? "";
    },
    async setToken(id: string, token: string): Promise<void> {
      await deps.local.setToken(id, token);
      if (deps.enabled()) {
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
      delete remoteTokens[id];
      if (vaultKey) {
        try {
          const dev = await deps.device();
          await deps.remote.putVault(await sealVault(remoteTokens, vaultKey));
          void dev;
        } catch {
          /* best effort */
        }
      }
    },
    async list(): Promise<ProviderKeyInfo[]> {
      const local = await deps.local.list();
      const seen = new Set(local.map((i) => i.id));
      const merged = [...local];
      for (const id of Object.keys(remoteTokens)) {
        if (!seen.has(id)) merged.push({ id, name: id, configured: true, updatedAt: null });
      }
      return merged;
    },
  };
}
