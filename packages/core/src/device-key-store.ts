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
    let req: IDBRequest<T>;
    try {
      req = run(store);
    } catch (error) {
      reject(error);
      return;
    }
    req.onsuccess = () => resolve(req.result);
    req.onerror = (event) => {
      // Prevent Chromium from reporting a handled DataCloneError as an
      // uncaught IndexedDB exception (some CryptoKey implementations cannot
      // be structured-cloned even though IDB itself is available).
      event.preventDefault();
      reject(req.error);
    };
  });
}

/** Remove the persisted browser device identity when signing out.
 *
 * Device keys must not be reused across accounts: the control plane deliberately
 * rejects a public key that is already owned by another account. */
export async function clearIndexedDbDeviceKey(): Promise<void> {
  if (!idbAvailable()) return;
  const db = await openDb();
  try {
    await idbRequest(db.transaction(STORE, "readwrite").objectStore(STORE), (s) => s.delete(RECORD_KEY));
  } finally {
    db.close();
  }
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
      // Some Chromium/WebKit versions expose CryptoKey but cannot structured-
      // clone X25519 keys into IndexedDB. Check before opening a transaction so
      // the expected fallback in deviceKeypair does not produce a noisy
      // DataCloneError in the console.
      try {
        const clone = (globalThis as { structuredClone?: (value: unknown) => unknown }).structuredClone;
        if (clone) clone({ priv, pub });
      } catch {
        throw new Error("IndexedDB cannot clone this device key");
      }
      const db = await openDb();
      try {
        const tx = db.transaction(STORE, "readwrite");
        // A failed structured clone aborts the transaction as well as the
        // request. Handle that event before issuing the request so the browser
        // does not surface a second unhandled transaction error.
        tx.onerror = (event) => event.preventDefault();
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
