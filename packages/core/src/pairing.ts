// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// X25519 device pairing (mirrors src/pairing-crypto.ts on the node and the
// legacy handlePairFrame handshake). The room key is never carried in the QR:
// the node advertises its X25519 public key + a single-use pairing secret; the
// device proves it holds the secret (HMAC over its own public key) and receives
// the room key ECDH+HKDF-wrapped over the relay. The relay never learns it.

import { b64url, unb64url } from "./base64.js";
import { HKDF_INFO, WRAP_KEY_BYTES } from "./wire-format.js";
import type { DeviceKeyRecord, LocalStore } from "./local-store.js";
import { indexedDbDeviceKeyStore, type DeviceKeyStore } from "./device-key-store.js";

export interface DeviceKeypair {
  priv: CryptoKey;
  pub: string; // base64url raw public key
}

/**
 * Load the persisted device X25519 keypair, generating + storing one on first use.
 *
 * In a real browser the private key lives as a **non-extractable CryptoKey** in
 * IndexedDB (XSS can use it but never read the raw bytes). A legacy extractable
 * key in localStorage is migrated in place — same key identity, so existing
 * device pairings keep working — and the extractable copy is then removed. When
 * IndexedDB is unavailable (Node/tests), it falls back to the localStorage path.
 *
 * `keyStore` is injectable for testing; defaults to the IndexedDB store.
 */
export async function deviceKeypair(store: LocalStore, keyStore?: DeviceKeyStore): Promise<DeviceKeypair> {
  const secureStore = keyStore ?? indexedDbDeviceKeyStore();

  if (secureStore) {
    try {
      const existing = await secureStore.load();
      if (existing) return existing;

      // Migrate a legacy extractable key (same identity) into the secure store,
      // re-importing it as NON-extractable, then drop the localStorage copy.
      const legacy: DeviceKeyRecord | null = store.device();
      if (legacy) {
        const priv = await crypto.subtle.importKey(
          "pkcs8",
          unb64url(legacy.priv) as BufferSource,
          { name: "X25519" },
          false,
          ["deriveBits"],
        );
        await secureStore.save(priv, legacy.pub);
        store.clearDevice();
        return { priv, pub: legacy.pub };
      }

      // Fresh: generate a non-extractable private key (public keys are always
      // exportable), persist the CryptoKey object itself.
      const kp = (await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"])) as CryptoKeyPair;
      const pub = b64url(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
      await secureStore.save(kp.privateKey, pub);
      return { priv: kp.privateKey, pub };
    } catch {
      // IndexedDB is present but unusable on this install — observed on some iOS
      // home-screen PWAs, where opening/reading the object store can hang or the
      // stored CryptoKey fails to round-trip across cold launches. Falling
      // through to the localStorage-backed path keeps the device identity STABLE
      // instead of minting a fresh keypair every launch (which the control plane
      // sees as a brand-new "signed-in device" each time). The legacy key is
      // extractable, but localStorage has proven the more durable store here.
    }
  }

  // Legacy fallback (no IndexedDB, e.g. Node/tests, or a broken IDB above):
  // extractable key in storage.
  const saved: DeviceKeyRecord | null = store.device();
  if (saved) {
    const priv = await crypto.subtle.importKey("pkcs8", unb64url(saved.priv) as BufferSource, { name: "X25519" }, true, [
      "deriveBits",
    ]);
    return { priv, pub: saved.pub };
  }
  const kp = (await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
  const pubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const privPkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
  const pub = b64url(pubRaw);
  const priv = b64url(privPkcs8);
  store.setDevice({ pub, priv });
  return { priv: kp.privateKey, pub };
}

async function ecdhBits(privKey: CryptoKey, theirPubB64: string): Promise<Uint8Array> {
  const pub = await crypto.subtle.importKey("raw", unb64url(theirPubB64) as BufferSource, { name: "X25519" }, false, []);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "X25519", public: pub }, privKey, 256));
}

/** Derive the AES-GCM key that (un)wraps a delivery for the given purpose.
 *  `pair`/`rotate` only ever unwrap on this side (decrypt-only); `device-vault`
 *  must both PRODUCE and CONSUME ciphertext — a device seals the vault key for
 *  its peers and opens what a peer sealed for it — so it gets encrypt+decrypt. */
export async function wrapKeyFor(
  privKey: CryptoKey,
  nodePubB64: string,
  purpose: "pair" | "rotate" | "device-vault",
): Promise<CryptoKey> {
  const shared = await ecdhBits(privKey, nodePubB64);
  const base = await crypto.subtle.importKey("raw", shared as BufferSource, "HKDF", false, ["deriveBits"]);
  const infoStr = purpose === "rotate" ? HKDF_INFO.rotate : purpose === "device-vault" ? HKDF_INFO.deviceVault : HKDF_INFO.pair;
  const info = new TextEncoder().encode(infoStr);
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0) as BufferSource, info: info as BufferSource },
      base,
      WRAP_KEY_BYTES * 8,
    ),
  );
  const usages: KeyUsage[] = purpose === "device-vault" ? ["encrypt", "decrypt"] : ["decrypt"];
  return crypto.subtle.importKey("raw", bits as BufferSource, "AES-GCM", false, usages);
}

/** HMAC-SHA256 proof over the device public key, keyed by the pairing secret. */
export async function pairingProof(secretB64: string, devicePubB64: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    unb64url(secretB64) as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, unb64url(devicePubB64) as BufferSource)));
}
