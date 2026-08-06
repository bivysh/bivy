// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { describe, expect, it } from "vitest";
import { b64, b64url, unb64, unb64url, createLocalStore, deviceKeypair, wrapKeyFor, pairingProof, seal, open } from "../src/index.js";
import type { DeviceKeyStore } from "../src/index.js";

function mem(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    get length() {
      return m.size;
    },
  } as unknown as Storage;
}

// In-memory stand-in for the IndexedDB key store, holding the CryptoKey object
// (mirrors how IDB structured-clones it, preserving non-extractability).
function memKeyStore(): DeviceKeyStore {
  let rec: { priv: CryptoKey; pub: string } | null = null;
  return {
    async load() {
      return rec;
    },
    async save(priv, pub) {
      rec = { priv, pub };
    },
  };
}

// Simulate the node side of the handshake so we prove device unwrap matches.
async function nodeWrapEncKey(nodePriv: CryptoKey, devicePubB64: string, purpose: "pair" | "rotate") {
  const devPub = await crypto.subtle.importKey("raw", unb64url(devicePubB64) as BufferSource, { name: "X25519" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "X25519", public: devPub }, nodePriv, 256));
  const base = await crypto.subtle.importKey("raw", shared as BufferSource, "HKDF", false, ["deriveBits"]);
  const info = new TextEncoder().encode(purpose === "rotate" ? "bivy-rotate-v1" : "bivy-pair-v1");
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0) as BufferSource, info: info as BufferSource },
      base,
      256,
    ),
  );
  return crypto.subtle.importKey("raw", bits as BufferSource, "AES-GCM", false, ["encrypt"]);
}

describe("pairing handshake", () => {
  it("device unwraps a room key the node wrapped for it (ECDH + HKDF)", async () => {
    const nodeKp = (await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
    const nodePubB64 = b64url(new Uint8Array(await crypto.subtle.exportKey("raw", nodeKp.publicKey)));

    const store = createLocalStore(mem(), mem());
    const dev = await deviceKeypair(store);

    const roomKey = crypto.getRandomValues(new Uint8Array(32));
    const wrapEnc = await nodeWrapEncKey(nodeKp.privateKey, dev.pub, "pair");
    const wrapped = await seal(wrapEnc, b64(roomKey)); // node ships b64(roomKey) sealed

    const wrapDec = await wrapKeyFor(dev.priv, nodePubB64, "pair");
    const unwrapped = unb64(await open(wrapDec, wrapped));
    expect(Array.from(unwrapped)).toEqual(Array.from(roomKey));
  });

  it("persists and reuses the device keypair", async () => {
    const storage = mem();
    const store = createLocalStore(storage, mem());
    const a = await deviceKeypair(store);
    const b = await deviceKeypair(store);
    expect(a.pub).toBe(b.pub);
  });

  it("produces a stable HMAC pairing proof", async () => {
    const store = createLocalStore(mem(), mem());
    const dev = await deviceKeypair(store);
    const secret = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const p1 = await pairingProof(secret, dev.pub);
    const p2 = await pairingProof(secret, dev.pub);
    expect(p1).toBe(p2);
    expect(p1).not.toMatch(/[+/=]/);
  });

  it("stores the private key non-extractably in the secure key store", async () => {
    const store = createLocalStore(mem(), mem());
    const keyStore = memKeyStore();
    const dev = await deviceKeypair(store, keyStore);

    // The generated private key must be non-extractable, and nothing extractable
    // should be written to localStorage.
    expect(dev.priv.extractable).toBe(false);
    expect(store.device()).toBeNull();

    // Reused on the next call (same identity) and still usable for ECDH.
    const again = await deviceKeypair(store, keyStore);
    expect(again.pub).toBe(dev.pub);

    const nodeKp = (await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
    const nodePubB64 = b64url(new Uint8Array(await crypto.subtle.exportKey("raw", nodeKp.publicKey)));
    const roomKey = crypto.getRandomValues(new Uint8Array(32));
    const wrapEnc = await nodeWrapEncKey(nodeKp.privateKey, dev.pub, "pair");
    const wrapped = await seal(wrapEnc, b64(roomKey));
    const wrapDec = await wrapKeyFor(dev.priv, nodePubB64, "pair");
    expect(Array.from(unb64(await open(wrapDec, wrapped)))).toEqual(Array.from(roomKey));
  });

  it("falls back to a stable localStorage keypair when the secure store is broken", async () => {
    // Simulate an iOS PWA whose IndexedDB is present but unusable: load/save
    // reject. The keypair must still be STABLE across launches (same identity),
    // via the durable localStorage-backed path — not a fresh key every call
    // (which the control plane would see as a new device every time).
    const brokenKeyStore: DeviceKeyStore = {
      async load() {
        throw new Error("indexedDB unavailable");
      },
      async save() {
        throw new Error("indexedDB unavailable");
      },
    };
    const storage = mem();
    const store = createLocalStore(storage, mem());
    const a = await deviceKeypair(store, brokenKeyStore);
    const b = await deviceKeypair(store, brokenKeyStore);
    expect(a.pub).toBe(b.pub);
    expect(store.device()).not.toBeNull(); // persisted to localStorage
  });

  it("migrates a legacy extractable key into the secure store, same identity", async () => {
    // Seed the legacy path: an extractable key persisted in localStorage.
    const legacyStorage = mem();
    const legacyStore = createLocalStore(legacyStorage, mem());
    const legacy = await deviceKeypair(legacyStore); // no keyStore → legacy path
    expect(legacyStore.device()).not.toBeNull();

    // Now run with a secure key store: it should migrate in place.
    const keyStore = memKeyStore();
    const migrated = await deviceKeypair(legacyStore, keyStore);
    expect(migrated.pub).toBe(legacy.pub); // same device identity preserved
    expect(migrated.priv.extractable).toBe(false); // re-imported non-extractable
    expect(legacyStore.device()).toBeNull(); // legacy extractable copy removed

    // Subsequent loads come from the secure store, not localStorage.
    const reused = await deviceKeypair(legacyStore, keyStore);
    expect(reused.pub).toBe(legacy.pub);
  });
});
