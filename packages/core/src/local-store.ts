// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Device-local persistence, ported from public/app/session-state.js.
//
// Holds everything the client needs to reconnect to a node: the control-plane
// session token, the current node id + relay URL, per-node room keys and X25519
// node public keys, single-use pairing secrets (kept in sessionStorage so they
// don't outlive the tab), and the device keypair. Storage is injectable so the
// same shape is testable without a browser.

export interface DeviceKeyRecord {
  pub: string;
  priv: string;
}

type Dict = Record<string, string>;

function jsonGet<T>(storage: Pick<Storage, "getItem">, key: string, fallback: T): T {
  try {
    return JSON.parse(storage.getItem(key) || JSON.stringify(fallback)) as T;
  } catch {
    return fallback;
  }
}

export interface LocalStore {
  s: string; // control-plane session/bearer token
  cp: string; // control-plane base URL
  relay: string; // fallback relay URL
  cur: string; // current node id
  keys(): Dict;
  addKey(id: string, key: string): void;
  nodePubs(): Dict;
  addNodePub(id: string, pub: string): void;
  pairSecrets(): Dict;
  setPairSecret(id: string, secret: string): void;
  clearPairSecret(id: string): void;
  /** Account-free ("solo") relay creds for a node: an unguessable room id + its
   *  bearer token, learned from the pairing QR. Persisted (not sessionStorage):
   *  unlike a single-use pairSecret, the token is presented on every relay dial. */
  solo(): Record<string, { room: string; roomToken: string }>;
  setSolo(id: string, creds: { room: string; roomToken: string }): void;
  device(): DeviceKeyRecord | null;
  setDevice(d: DeviceKeyRecord): void;
  /** Remove the legacy extractable device key (after migrating it to a
   * non-extractable CryptoKey in IndexedDB). */
  clearDevice(): void;
  sessions(): Record<string, unknown[]>;
  setSessions(nodeId: string, sessions: unknown[]): void;
  /** Remembered composer defaults for a fresh session: repo/agent/model. */
  lastChoice(): LastChoice;
  setLastChoice(patch: Partial<LastChoice>): void;
  clear(): void;
}

export interface LastChoice {
  repo?: string | null;
  agentId?: string;
  modelProvider?: string;
  modelId?: string;
}

export function createLocalStore(storage: Storage, volatile?: Storage): LocalStore {
  const volatileStorage: Storage = volatile ?? (() => {
    try {
      return globalThis.sessionStorage || storage;
    } catch {
      return storage;
    }
  })();
  return {
    get s() {
      return storage.getItem("bivy_session") || "";
    },
    set s(v: string) {
      storage.setItem("bivy_session", v);
    },
    get cp() {
      return storage.getItem("bivy_cp") || "";
    },
    set cp(v: string) {
      storage.setItem("bivy_cp", v);
    },
    get relay() {
      return storage.getItem("bivy_relay") || "";
    },
    set relay(v: string) {
      storage.setItem("bivy_relay", v);
    },
    get cur() {
      return storage.getItem("bivy_current") || "";
    },
    set cur(v: string) {
      storage.setItem("bivy_current", v);
    },
    keys() {
      return jsonGet<Dict>(storage, "bivy_keys", {});
    },
    addKey(id, key) {
      const k = this.keys();
      k[id] = key;
      storage.setItem("bivy_keys", JSON.stringify(k));
    },
    nodePubs() {
      return jsonGet<Dict>(storage, "bivy_nodepubs", {});
    },
    addNodePub(id, pub) {
      const k = this.nodePubs();
      k[id] = pub;
      storage.setItem("bivy_nodepubs", JSON.stringify(k));
    },
    pairSecrets() {
      return jsonGet<Dict>(volatileStorage, "bivy_pairsecrets", {});
    },
    setPairSecret(id, secret) {
      const k = this.pairSecrets();
      k[id] = secret;
      volatileStorage.setItem("bivy_pairsecrets", JSON.stringify(k));
      try {
        storage.removeItem("bivy_pairsecrets");
      } catch {
        /* ignore */
      }
    },
    clearPairSecret(id) {
      const k = this.pairSecrets();
      delete k[id];
      volatileStorage.setItem("bivy_pairsecrets", JSON.stringify(k));
      try {
        storage.removeItem("bivy_pairsecrets");
      } catch {
        /* ignore */
      }
    },
    solo() {
      return jsonGet<Record<string, { room: string; roomToken: string }>>(storage, "bivy_solo", {});
    },
    setSolo(id, creds) {
      if (!id || !creds?.room || !creds?.roomToken) return;
      const all = this.solo();
      all[id] = { room: creds.room, roomToken: creds.roomToken };
      storage.setItem("bivy_solo", JSON.stringify(all));
    },
    device() {
      return jsonGet<DeviceKeyRecord | null>(storage, "bivy_device", null);
    },
    setDevice(d) {
      storage.setItem("bivy_device", JSON.stringify(d));
    },
    clearDevice() {
      try {
        storage.removeItem("bivy_device");
      } catch {
        /* ignore */
      }
    },
    sessions() {
      return jsonGet<Record<string, unknown[]>>(storage, "bivy_session_lists", {});
    },
    setSessions(nodeId, sessions) {
      if (!nodeId) return;
      const all = this.sessions();
      all[nodeId] = (sessions || []).slice(0, 100);
      storage.setItem("bivy_session_lists", JSON.stringify(all));
    },
    lastChoice() {
      return jsonGet<LastChoice>(storage, "bivy_last_choice", {});
    },
    setLastChoice(patch) {
      storage.setItem("bivy_last_choice", JSON.stringify({ ...this.lastChoice(), ...patch }));
    },
    clear() {
      for (const k of [
        "bivy_session",
        "bivy_cp",
        "bivy_relay",
        "bivy_current",
        "bivy_keys",
        "bivy_nodepubs",
        "bivy_pairsecrets",
        "bivy_solo",
        "bivy_device",
        "bivy_session_lists",
        "bivy_session_index",
        "bivy_deleted_sessions",
        "bivy_last_choice",
      ])
        storage.removeItem(k);
    },
  };
}
