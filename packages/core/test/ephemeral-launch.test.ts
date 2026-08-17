// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { describe, expect, it } from "vitest";
import {
  createEphemeralKeyStore,
  createMachineStore,
  launchEphemeralMachine,
  memoryBackend,
  type ExecFn,
  type LocalStore,
} from "../src/index.js";

// A LocalStore is a big interface, but launchEphemeralMachine only touches a
// handful of members — the control-plane base/token, the relay url, and the
// per-node room-key sink. Stub just those.
function fakeStore(): LocalStore {
  const keys: Record<string, string> = {};
  return {
    s: "sess-tok",
    cp: "https://app.example",
    relay: "wss://relay.example",
    cur: "",
    keys: () => ({ ...keys }),
    addKey: (id, key) => { keys[id] = key; },
  } as unknown as LocalStore;
}

// The Fly adapter provisions by first resolving the token's org over GraphQL,
// then create-app + create-machine. Return a machine whose provider-generated
// name is the Fly app name so the test can prove the caller's chosen name
// overrides it on the stored record.
const flyExec: ExecFn = async (req) => {
  if (req.url === "https://api.fly.io/graphql") return { status: 200, body: { data: { organizations: { nodes: [{ slug: "personal", type: "PERSONAL" }] } } } };
  if (req.url.endsWith("/v1/apps")) return { status: 201, body: {} };
  return { status: 200, body: { id: "flymachine123", state: "created" } };
};

describe("launchEphemeralMachine — durable lifecycle", () => {
  it("awaits durable intent before enrollment and records provider identity before tracking", async () => {
    const keys = createEphemeralKeyStore(memoryBackend());
    await keys.setToken("fly", "fly-tok");
    const machines = createMachineStore(memoryBackend());
    const order: string[] = [];
    const attemptId = "attempt-001";
    const machine = await launchEphemeralMachine(
      {
        provider: "fly", attemptId,
        onLifecycle: async (event) => { order.push(event.phase); },
      },
      {
        store: fakeStore(), exec: flyExec, keys, machines,
        fetchImpl: (async () => {
          expect(order).toEqual(["requested"]);
          return { ok: true, json: async () => ({ enrollmentToken: "enroll-tok" }) };
        }) as unknown as typeof fetch,
      },
    );
    expect(machine.attemptId).toBe(attemptId);
    expect(order).toEqual(["requested", "enrolled", "provider-accepted", "tracked"]);
  });

  it("refuses device-only providers whose guest shutdown cannot stop billing", async () => {
    const keys = createEphemeralKeyStore(memoryBackend());
    await keys.setToken("hetzner", "hz-token");
    let fetched = false;
    await expect(launchEphemeralMachine(
      { provider: "hetzner" },
      {
        store: fakeStore(), exec: flyExec, keys, machines: createMachineStore(memoryBackend()),
        fetchImpl: (async () => { fetched = true; return {} as Response; }) as typeof fetch,
      },
    )).rejects.toThrow(/requires hosted provisioning/);
    expect(fetched).toBe(false);
  });

  it("refuses a removed provider before reading credentials or enrolling", async () => {
    let fetched = false;
    await expect(launchEphemeralMachine(
      { provider: "e2b" },
      {
        store: fakeStore(), exec: flyExec,
        keys: createEphemeralKeyStore(memoryBackend()),
        machines: createMachineStore(memoryBackend()),
        fetchImpl: (async () => { fetched = true; return {} as Response; }) as typeof fetch,
      },
    )).rejects.toThrow(/unknown provider: e2b/i);
    expect(fetched).toBe(false);
  });

  it("does not enroll if durable intent persistence fails", async () => {
    const keys = createEphemeralKeyStore(memoryBackend());
    await keys.setToken("fly", "fly-tok");
    let fetched = false;
    await expect(launchEphemeralMachine(
      { provider: "fly", onLifecycle: async () => { throw new Error("database unavailable"); } },
      {
        store: fakeStore(), exec: flyExec, keys, machines: createMachineStore(memoryBackend()),
        fetchImpl: (async () => { fetched = true; return {} as Response; }) as typeof fetch,
      },
    )).rejects.toThrow("database unavailable");
    expect(fetched).toBe(false);
  });
});

describe("launchEphemeralMachine — machine record naming", () => {
  it("persists the setup's chosen name and setupId onto the stored machine", async () => {
    const keys = createEphemeralKeyStore(memoryBackend());
    await keys.setToken("fly", "fly-tok");
    const machines = createMachineStore(memoryBackend());
    const progress: string[] = [];

    const machine = await launchEphemeralMachine(
      {
        provider: "fly",
        region: "lhr",
        size: "shared-1x-2gb",
        name: "EU coding node",
        setupId: "setup-abc",
        ttlMinutes: 60,
        onProgress: (message) => progress.push(message),
      },
      {
        store: fakeStore(),
        exec: flyExec,
        keys,
        machines,
        fetchImpl: (async () => ({
          ok: true,
          json: async () => ({ enrollmentToken: "enroll-tok" }),
        })) as unknown as typeof fetch,
      },
    );

    // The chosen name wins over Fly's `bivy-<slug>` default, and the setup link
    // is stamped through — both are what the node switcher relies on.
    expect(machine.name).toBe("EU coding node");
    expect(machine.setupId).toBe("setup-abc");
    expect(machine.nodeId).toMatch(/^eph-/);
    expect(progress).toEqual([
      "Preparing Fly.io launch…",
      "Enrolling a secure Bivy node…",
      "Node enrolled. Building its secure bootstrap…",
      "Creating the machine in lhr (shared-1x-2gb)…",
      "Machine created. Boot setup is installing and starting Bivy…",
    ]);

    const stored = await machines.list();
    expect(stored[0]?.name).toBe("EU coding node");
    expect(stored[0]?.setupId).toBe("setup-abc");
  });

  it("keeps the provider-generated name for an ad-hoc launch with no name", async () => {
    const keys = createEphemeralKeyStore(memoryBackend());
    await keys.setToken("fly", "fly-tok");
    const machines = createMachineStore(memoryBackend());

    const machine = await launchEphemeralMachine(
      { provider: "fly", region: "lhr" },
      {
        store: fakeStore(),
        exec: flyExec,
        keys,
        machines,
        fetchImpl: (async () => ({
          ok: true,
          json: async () => ({ enrollmentToken: "enroll-tok" }),
        })) as unknown as typeof fetch,
      },
    );

    expect(machine.name).toMatch(/^bivy-/);
    expect(machine.setupId).toBeUndefined();
  });
});
