// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Persistence for the device's X25519 private key.
//
// The private key is the root of the device's E2E identity (it unwraps the room
// key over the relay). The legacy path kept it as an *extractable* pkcs8 blob in
// localStorage, so any XSS could read it and persist it forever. In a real
// browser we instead store the private key as a **non-extractable CryptoKey** in
// IndexedDB: structured-clone preserves the key object AND its non-extractability,
// so script can still *use* it (deriveBits) but can never read the raw bytes out.
//
// In non-browser contexts (Node tests, SSR) there is no IndexedDB; callers fall
// back to the localStorage-backed path, where extractability is moot — there is
// no hostile script surface.

export interface DeviceKeyStore {
  load(): Promise<{ priv: CryptoKey; pub: string } | null>;
  save(priv: CryptoKey, pub: string): Promise<void>;
}

const DB_NAME = "bivy";
const STORE = "device-key";
const RECORD_KEY = "x25519";

function idbAvailable(): boolean {
  try {
    return typeof globalThis !== "undefined" && !!(globalThis as { indexedDB?: unknown }).indexedDB;
  } catch {
    return false;
  }
}

// Some WebKit builds (notably iOS home-screen PWAs) can leave indexedDB.open
// pending indefinitely — no success, error, or upgrade event ever fires. A hung
// open would stall the whole pairing/connect flow, so bound it: on timeout we
// reject and the caller falls back to the durable localStorage-backed keypair.
const OPEN_TIMEOUT_MS = 4000;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error("indexedDB.open timed out"))), OPEN_TIMEOUT_MS);
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => finish(() => {
      clearTimeout(timer);
      resolve(req.result);
    });
    req.onerror = () => finish(() => {
      clearTimeout(timer);
      reject(req.error);
    });
    req.onblocked = () => finish(() => {
      clearTimeout(timer);
      reject(new Error("indexedDB.open blocked"));
    });
  });
}

function idbRequest<T>(store: IDBObjectStore, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = run(store);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * IndexedDB-backed store that keeps the private key as a non-extractable
 * CryptoKey. Returns null (never throws) when IndexedDB is unavailable so callers
 * can fall back to the legacy path.
 */
export function indexedDbDeviceKeyStore(): DeviceKeyStore | null {
  if (!idbAvailable()) return null;
  return {
    async load() {
      const db = await openDb();
      try {
        const rec = await idbRequest(db.transaction(STORE, "readonly").objectStore(STORE), (s) =>
          s.get(RECORD_KEY),
        );
        if (rec && rec.priv instanceof CryptoKey && typeof rec.pub === "string") {
          return { priv: rec.priv as CryptoKey, pub: rec.pub as string };
        }
        return null;
      } finally {
        db.close();
      }
    },
    async save(priv, pub) {
      const db = await openDb();
      try {
        const tx = db.transaction(STORE, "readwrite");
        await idbRequest(tx.objectStore(STORE), (s) => s.put({ priv, pub }, RECORD_KEY));
        await new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        });
      } finally {
        db.close();
      }
    },
  };
}
