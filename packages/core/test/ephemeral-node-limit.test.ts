// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { describe, expect, it } from "vitest";
import {
  createLocalStore,
  createMachineStore,
  memoryBackend,
  reapOrphanEphemeralNodes,
  launchEphemeralMachine,
  type EphemeralKeyStore,
  type ExecFn,
  type ExecRequest,
  type LocalStore,
} from "../src/index.js";

// A self-destructed (or never-booted) ephemeral machine leaves its enrolled
// `eph-*` node behind — nothing tells the control plane the box is gone. Enough
// orphans and the account hits its plan node limit, so every new launch fails
// enrollment with a 402 that surfaces as "Could not enroll the machine". The
// launch path reaps its own orphans and retries so the account self-heals.

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

function makeStore(): LocalStore {
  const store = createLocalStore(mem(), mem());
  store.s = "session-tok";
  store.cp = "https://app.bivy.sh";
  store.relay = "wss://relay.bivy.sh";
  return store;
}

const ISO_NOW = new Date().toISOString();
const ISO_OLD = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago

const ACCOUNT_NODES = [
  { id: "eph-orphan1", name: "Ephemeral Fly", online: false }, // reap (no local record)
  { id: "eph-orphan2", name: "Ephemeral Fly", online: false }, // reap (no local record)
  { id: "eph-online", name: "Ephemeral Fly", online: true }, // live machine — keep
  { id: "eph-booting", name: "Ephemeral Fly", online: false }, // tracked + fresh — keep
  { id: "eph-dead", name: "Ephemeral Fly", online: false }, // tracked but stale — reap + drop record
  { id: "mac-home", name: "Mac.home", online: false }, // persistent node — NEVER touch
];

describe("reapOrphanEphemeralNodes", () => {
  it("deletes offline eph-* nodes past their boot grace, sparing persistent, online, and still-booting ones", async () => {
    const store = makeStore();
    const machines = createMachineStore(memoryBackend());
    await machines.add({ id: "m-booting", provider: "fly", nodeId: "eph-booting", status: "starting", createdAt: ISO_NOW } as never);
    await machines.add({ id: "m-dead", provider: "fly", nodeId: "eph-dead", status: "starting", createdAt: ISO_OLD } as never);

    const deleted: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url.endsWith("/nodes") && (!init || init.method === undefined)) {
        return { ok: true, status: 200, json: async () => ACCOUNT_NODES } as Response;
      }
      const m = /\/nodes\/([^/?]+)$/.exec(url);
      if (m && init?.method === "DELETE") {
        deleted.push(decodeURIComponent(m[1]));
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
      }
      throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
    }) as unknown as typeof fetch;

    const reaped = await reapOrphanEphemeralNodes({ store, machines }, fetchImpl);
    expect(reaped).toBe(3);
    expect(deleted.sort()).toEqual(["eph-dead", "eph-orphan1", "eph-orphan2"]);
    // The stale machine's lingering local record is dropped; the booting one stays.
    const ids = (await machines.list()).map((m) => m.id);
    expect(ids).toContain("m-booting");
    expect(ids).not.toContain("m-dead");
  });

  it("reaps nothing when the node list can't be fetched", async () => {
    const store = makeStore();
    const machines = createMachineStore(memoryBackend());
    const fetchImpl = (async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response) as unknown as typeof fetch;
    expect(await reapOrphanEphemeralNodes({ store, machines }, fetchImpl)).toBe(0);
  });
});

describe("launchEphemeralMachine — node-limit self-heal", () => {
  const keys: EphemeralKeyStore = {
    list: async () => [],
    getToken: async () => "fly-token",
    setToken: async () => {},
    remove: async () => {},
  };

  // Fly provider transport: succeeds at app + machine create.
  const flyExec: ExecFn = async (req: ExecRequest) => {
    if (req.url === "https://api.machines.dev/v1/apps") return { status: 201, body: {} };
    if (/\/machines$/.test(req.url)) return { status: 200, body: { id: "m-123", state: "starting" } };
    return { status: 404, body: null };
  };

  it("reaps an orphan and retries when the first enroll is a 402 node-limit", async () => {
    const store = makeStore();
    const machines = createMachineStore(memoryBackend());
    let enrollCalls = 0;
    const deleted: string[] = [];

    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url.endsWith("/nodes/enroll")) {
        enrollCalls++;
        if (enrollCalls === 1) {
          return { ok: false, status: 402, json: async () => ({ error: "Node limit reached (3)" }) } as Response;
        }
        return { ok: true, status: 200, json: async () => ({ ok: true, enrollmentToken: "enr_new", node: { name: "Ephemeral Fly" } }) } as Response;
      }
      if (url.endsWith("/nodes") && (!init || init.method === undefined)) {
        return { ok: true, status: 200, json: async () => [{ id: "eph-dead", online: false }] } as Response;
      }
      const m = /\/nodes\/([^/?]+)$/.exec(url);
      if (m && init?.method === "DELETE") {
        deleted.push(decodeURIComponent(m[1]));
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
      }
      throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
    }) as unknown as typeof fetch;

    const machine = await launchEphemeralMachine(
      { provider: "fly", region: "fra", size: "shared-2x-4gb", ttlMinutes: 60 },
      { store, exec: flyExec, keys, machines, fetchImpl },
    );

    expect(enrollCalls).toBe(2); // failed once, retried after reaping
    expect(deleted).toEqual(["eph-dead"]);
    expect(machine.id).toBe("m-123");
    expect((await machines.list()).some((m) => m.id === "m-123")).toBe(true);
  });

  it("surfaces the node-limit error when there is nothing to reap", async () => {
    const store = makeStore();
    const machines = createMachineStore(memoryBackend());
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url.endsWith("/nodes/enroll")) {
        return { ok: false, status: 402, json: async () => ({ error: "Node limit reached (3)" }) } as Response;
      }
      if (url.endsWith("/nodes") && (!init || init.method === undefined)) {
        return { ok: true, status: 200, json: async () => [] } as Response; // no orphans
      }
      throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
    }) as unknown as typeof fetch;

    await expect(
      launchEphemeralMachine(
        { provider: "fly", region: "fra", size: "shared-2x-4gb", ttlMinutes: 60 },
        { store, exec: flyExec, keys, machines, fetchImpl },
      ),
    ).rejects.toThrow(/node limit reached/i);
  });
});
