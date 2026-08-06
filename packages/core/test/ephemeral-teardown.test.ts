// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { describe, expect, it } from "vitest";
import {
  createEphemeralKeyStore,
  createMachineStore,
  destroyEphemeralMachine,
  ephemeralCostHint,
  formatEphemeralPrice,
  memoryBackend,
  type EphemeralMachine,
  type ExecFn,
  type LocalStore,
} from "../src/index.js";

function fakeStore(): LocalStore {
  return {
    s: "sess-tok",
    cp: "https://app.example",
    relay: "wss://relay.example",
    cur: "",
    keys: () => ({}),
    addKey: () => {},
  } as unknown as LocalStore;
}

function flyMachine(): EphemeralMachine {
  return {
    id: "flymachine123",
    provider: "fly",
    name: "runner",
    region: "iad",
    status: "running",
    ip: null,
    createdAt: "2026-01-01T00:00:00Z",
    nodeId: "eph-abcdef01",
  };
}

// A machine that the provider refuses to destroy must stay listed so the user
// can retry — silently forgetting it strands a live, billing machine. This was
// the pre-fix behavior (the record was removed regardless of the outcome).
describe("destroyEphemeralMachine — teardown failure", () => {
  it("keeps the local record and throws when the provider destroy call fails", async () => {
    const keys = createEphemeralKeyStore(memoryBackend());
    await keys.setToken("fly", "fly-tok");
    const machines = createMachineStore(memoryBackend());
    const machine = flyMachine();
    await machines.add(machine);

    let unenrolled = false;
    const failingExec: ExecFn = async () => ({ status: 500, body: { error: "boom" } });

    await expect(
      destroyEphemeralMachine(machine, {
        store: fakeStore(),
        exec: failingExec,
        keys,
        machines,
        fetchImpl: (async () => {
          unenrolled = true;
          return { ok: true, json: async () => ({}) };
        }) as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/couldn't destroy/i);

    // Still listed for a retry, and we did NOT unenroll the node.
    expect((await machines.list()).map((m) => m.id)).toContain("flymachine123");
    expect(unenrolled).toBe(false);
  });

  it("removes the record and unenrolls the node on a successful destroy", async () => {
    const keys = createEphemeralKeyStore(memoryBackend());
    await keys.setToken("fly", "fly-tok");
    const machines = createMachineStore(memoryBackend());
    const machine = flyMachine();
    await machines.add(machine);

    let unenrolled = false;
    const okExec: ExecFn = async () => ({ status: 200, body: {} });

    await destroyEphemeralMachine(machine, {
      store: fakeStore(),
      exec: okExec,
      keys,
      machines,
      fetchImpl: (async () => {
        unenrolled = true;
        return { ok: true, json: async () => ({}) };
      }) as unknown as typeof fetch,
    });

    expect(await machines.list()).toHaveLength(0);
    expect(unenrolled).toBe(true);
  });

  it("keeps the record and asks for the token when none is saved", async () => {
    const keys = createEphemeralKeyStore(memoryBackend());
    // no token saved
    const machines = createMachineStore(memoryBackend());
    const machine = flyMachine();
    await machines.add(machine);

    await expect(
      destroyEphemeralMachine(machine, {
        store: fakeStore(),
        exec: (async () => ({ status: 200, body: {} })) as ExecFn,
        keys,
        machines,
        fetchImpl: (async () => ({ ok: true, json: async () => ({}) })) as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/token/i);

    expect((await machines.list()).map((m) => m.id)).toContain("flymachine123");
  });
});

describe("ephemeral cost hints", () => {
  it("formats sub-10-cent prices with more precision", () => {
    expect(formatEphemeralPrice(0.0136, "USD")).toBe("$0.0136");
    expect(formatEphemeralPrice(0.007, "EUR")).toBe("€0.0070");
    expect(formatEphemeralPrice(0.5, "USD")).toBe("$0.50");
  });

  it("returns an hourly + TTL-ceiling estimate for a priced size", () => {
    const hint = ephemeralCostHint({ id: "cpx21", label: "cpx21", pricePerHour: 0.013 }, 180, "EUR");
    expect(hint).toContain("€0.0130/hr");
    expect(hint).toContain("€0.0390"); // 3 hours
  });

  it("is empty when the size carries no price", () => {
    expect(ephemeralCostHint({ id: "x", label: "x" }, 60, "USD")).toBe("");
    expect(ephemeralCostHint(undefined, 60, "USD")).toBe("");
  });

  it("shows only the hourly rate when no TTL is given", () => {
    expect(ephemeralCostHint({ id: "x", label: "x", pricePerHour: 0.5 }, undefined, "USD")).toBe("≈ $0.50/hr");
  });
});
