// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { b64url, createLocalStore, deviceKeypair, indexedDbDeviceKeyStore } from "../src/index.js";

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

// Exercises the real IndexedDB-backed key store (via fake-indexeddb) — the code
// path the browser uses by default, not covered by the injected in-memory store.
describe("indexedDbDeviceKeyStore (real IDB)", () => {
  it("is available when indexedDB exists", () => {
    expect(indexedDbDeviceKeyStore()).not.toBeNull();
  });

  it("round-trips a non-extractable CryptoKey across store instances", async () => {
    const kp = (await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"])) as CryptoKeyPair;
    const pub = b64url(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));

    await indexedDbDeviceKeyStore()!.save(kp.privateKey, pub);

    // A fresh store instance (fresh DB connection) reads it back.
    const loaded = await indexedDbDeviceKeyStore()!.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.pub).toBe(pub);
    expect(loaded!.priv).toBeInstanceOf(CryptoKey);
    expect(loaded!.priv.extractable).toBe(false);

    // Still usable for ECDH after the IDB round-trip.
    const bits = await crypto.subtle.deriveBits({ name: "X25519", public: kp.publicKey }, loaded!.priv, 256);
    expect(new Uint8Array(bits).length).toBe(32);
  });

  it("deviceKeypair uses IDB by default and reuses the same identity", async () => {
    // Isolate from the previous test's record by using this run's own DB is not
    // possible (fixed name), so assert reuse semantics rather than freshness.
    const store = createLocalStore(mem(), mem());
    const a = await deviceKeypair(store); // no injected keyStore → real IDB
    const b = await deviceKeypair(store);
    expect(a.pub).toBe(b.pub);
    expect(a.priv.extractable).toBe(false);
    expect(store.device()).toBeNull(); // nothing extractable in localStorage
  });
});
