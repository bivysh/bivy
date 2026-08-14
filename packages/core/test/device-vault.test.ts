// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { describe, expect, it } from "vitest";
import {
  createDeviceVaultKeyStore,
  DeviceVaultConflictError,
  createEphemeralKeyStore,
  createEphemeralModelKeyStore,
  memoryBackend,
  wrapKeyFor,
  seal,
  open,
  b64url,
  type DeviceKeypair,
  type DeviceVaultRemote,
  type DeviceVaultWrappedKey,
} from "../src/index.js";

async function makeDevice(): Promise<DeviceKeypair> {
  const kp = (await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  return { priv: kp.privateKey, pub: b64url(raw) };
}

/** In-memory control plane shared across devices: ciphertext + per-device
 *  wrapped keys + pending requests, exactly what the CP stores. */
function fakeControlPlane() {
  let vault: string | null = null;
  let generation = 0;
  let keyGeneration = 0;
  const wrapped: Record<string, DeviceVaultWrappedKey> = {};
  const requests = new Set<string>();
  const recipients = new Set<string>();
  return {
    peekVault: () => vault,
    revoke(pub: string) { recipients.delete(pub); delete wrapped[pub]; keyGeneration += 1; },
    forDevice(devPub: string): DeviceVaultRemote {
      recipients.add(devPub);
      return {
        async get() {
          return { vault, wrappedKey: wrapped[devPub] ?? null, requests: [...requests], generation, keyGeneration, recipients: [...recipients] };
        },
        async putVault(ct, expected = 0, keyEpoch = 0) {
          if (expected !== generation || keyEpoch !== keyGeneration) throw new DeviceVaultConflictError();
          vault = ct;
          generation += 1;
          return { generation };
        },
        async requestKey() {
          requests.add(devPub);
        },
        async putWrapped(target, wrappedKey, wrappedByPublicKeyB64, epoch = 0) {
          if (!recipients.has(target) || epoch !== keyGeneration) throw new Error("stale recipient or epoch");
          wrapped[target] = { wrappedKey, wrappedByPublicKeyB64, generation: epoch };
          requests.delete(target);
        },
      };
    },
  };
}

const store = (dev: DeviceKeypair, remote: DeviceVaultRemote, enabled = true) =>
  createDeviceVaultKeyStore({
    local: createEphemeralKeyStore(memoryBackend()),
    modelKeys: createEphemeralModelKeyStore(memoryBackend()),
    remote,
    device: async () => dev,
    enabled: () => enabled,
  });

describe("device vault — cross-device token sync", () => {
  it("delivers a token from the producing device to a fresh second device", async () => {
    const A = await makeDevice();
    const B = await makeDevice();
    const cp = fakeControlPlane();
    const a = store(A, cp.forDevice(A.pub));
    const b = store(B, cp.forDevice(B.pub));

    // Device A saves a provider token → becomes the producer (seals + self-wraps).
    await a.setToken("fly", "fly-token-123");
    expect(cp.peekVault()).toBeTruthy(); // CP holds ciphertext, never the token

    // Current paired recipients are proactively wrapped, so B can consume on
    // its first read (older servers fall back to the request/response path).
    expect(await b.getToken("fly")).toBe("fly-token-123");
  });

  it("syncs account model/voice keys, but never device-only keys", async () => {
    const A = await makeDevice();
    const B = await makeDevice();
    const cp = fakeControlPlane();
    const a = store(A, cp.forDevice(A.pub));
    const b = store(B, cp.forDevice(B.pub));

    await a.setModelKey("openai", "account-openai", "account");
    await a.setModelKey("groq", "device-groq", "device");
    expect(cp.peekVault()).not.toContain("account-openai");
    expect(await b.getModelKey("openai")).toBe("account-openai");
    expect(await b.getModelKey("groq")).toBe("");
  });

  it("prefers the device-local token over the synced copy", async () => {
    const A = await makeDevice();
    const B = await makeDevice();
    const cp = fakeControlPlane();
    const a = store(A, cp.forDevice(A.pub));
    const b = store(B, cp.forDevice(B.pub));
    await a.setToken("fly", "from-A");
    await b.setToken("fly", "local-on-B"); // B is also a producer now
    expect(await b.getToken("fly")).toBe("local-on-B");
  });

  it("stays purely local when the vault is disabled (no CP calls, no leak)", async () => {
    const A = await makeDevice();
    let touched = 0;
    const remote: DeviceVaultRemote = {
      get: async () => { touched++; return { vault: null, wrappedKey: null, requests: [] }; },
      putVault: async () => { touched++; },
      requestKey: async () => { touched++; },
      putWrapped: async () => { touched++; },
    };
    const a = store(A, remote, /* enabled */ false);
    await a.setToken("fly", "secret");
    expect(await a.getToken("fly")).toBe("secret"); // local works
    expect(await a.getToken("hetzner")).toBe(""); // absent
    expect(touched).toBe(0); // never contacted the control plane
  });

  it("the CP only ever holds opaque ciphertext (never the plaintext token)", async () => {
    const A = await makeDevice();
    const cp = fakeControlPlane();
    const a = store(A, cp.forDevice(A.pub));
    await a.setToken("fly", "super-secret-token");
    expect(cp.peekVault()).not.toContain("super-secret-token");
  });

  it("a delete tombstone beats an offline device's stale value", async () => {
    const A = await makeDevice();
    const B = await makeDevice();
    const cp = fakeControlPlane();
    const a = store(A, cp.forDevice(A.pub));
    const b = store(B, cp.forDevice(B.pub));
    await a.setToken("fly", "old-token");
    await b.sync();
    await a.remove("fly");
    await b.sync();
    expect(await b.getToken("fly")).toBe("");
    await b.sync();
    await a.sync();
    expect(await a.getToken("fly")).toBe("");
  });

  it("delete followed by re-login converges to the newer credential", async () => {
    const A = await makeDevice();
    const B = await makeDevice();
    const cp = fakeControlPlane();
    const a = store(A, cp.forDevice(A.pub));
    const b = store(B, cp.forDevice(B.pub));
    await a.setToken("fly", "old");
    await b.sync();
    await a.remove("fly");
    await a.setToken("fly", "new");
    await b.sync();
    expect(await b.getToken("fly")).toBe("new");
  });

  it("rotates and rewraps the key only for survivors after revocation", async () => {
    const A = await makeDevice();
    const B = await makeDevice();
    const cp = fakeControlPlane();
    const a = store(A, cp.forDevice(A.pub));
    const b = store(B, cp.forDevice(B.pub));
    await a.setToken("fly", "secret");
    await b.sync();
    cp.revoke(B.pub);
    await a.sync();
    await expect(b.sync()).rejects.toThrow();
  });

  it("persists failed/pending sync state and exposes recovery", async () => {
    const A = await makeDevice();
    let fail = true;
    let saved: any;
    const remote: DeviceVaultRemote = {
      get: async () => { if (fail) throw new Error("offline"); return { vault: null, wrappedKey: null, requests: [] }; },
      putVault: async () => ({ generation: 1 }), requestKey: async () => {}, putWrapped: async () => {},
    };
    const a = createDeviceVaultKeyStore({
      local: createEphemeralKeyStore(memoryBackend()), remote, device: async () => A, enabled: () => true,
      state: { load: async () => saved, save: async (value) => { saved = structuredClone(value); } },
    });
    await expect(a.sync()).rejects.toThrow("offline");
    expect(a.getSyncState()).toMatchObject({ phase: "failed", pending: true, failure: "offline" });
    fail = false;
    await a.sync();
    expect(a.getSyncState().phase).toBe("pending"); // waiting for another device to wrap the key
  });

  it("device-vault wrap is a symmetric ECDH round-trip (produce ↔ consume)", async () => {
    const A = await makeDevice();
    const B = await makeDevice();
    const wrapAtoB = await wrapKeyFor(A.priv, B.pub, "device-vault");
    const unwrapAtB = await wrapKeyFor(B.priv, A.pub, "device-vault");
    const sealed = await seal(wrapAtoB, "vault-key-material");
    expect(await open(unwrapAtB, sealed)).toBe("vault-key-material");
  });
});
