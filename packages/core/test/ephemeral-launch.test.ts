// SPDX-License-Identifier: FSL-1.1-ALv2
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

// The Fly adapter provisions with two exec calls: create-app then create-machine.
// Return a machine whose provider-generated name is the Fly app name so the test
// can prove the caller's chosen name overrides it on the stored record.
const flyExec: ExecFn = async (req) => {
  if (req.url.endsWith("/v1/apps")) return { status: 201, body: {} };
  return { status: 200, body: { id: "flymachine123", state: "created" } };
};

describe("launchEphemeralMachine — machine record naming", () => {
  it("persists the setup's chosen name and setupId onto the stored machine", async () => {
    const keys = createEphemeralKeyStore(memoryBackend());
    await keys.setToken("fly", "fly-tok");
    const machines = createMachineStore(memoryBackend());

    const machine = await launchEphemeralMachine(
      { provider: "fly", region: "lhr", size: "shared-1x-2gb", name: "EU coding node", setupId: "setup-abc", ttlMinutes: 60 },
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
