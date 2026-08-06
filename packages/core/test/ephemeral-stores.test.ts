// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { createEphemeralKeyStore, createEphemeralPrefsStore, createEphemeralSetupStore, createMachineStore, memoryBackend, type EphemeralMachine } from "../src/index.js";

// Regression: the provider-key store and the machine store used to share one
// IndexedDB database opened at a fixed version, so `onupgradeneeded` only ran
// for whichever store opened first. Saving a token created the DB with just the
// provider-keys store, and the later machine write then failed with
// "object store not found". Each store now owns its own database.
describe("ephemeral IndexedDB stores coexist (real IDB)", () => {
  it("adds a machine even after the key store creates its DB first", async () => {
    const keys = createEphemeralKeyStore();
    await keys.setToken("hetzner", "tok_abc"); // creates the provider-keys DB first

    const machines = createMachineStore();
    const machine: EphemeralMachine = {
      id: "eph-1",
      provider: "hetzner",
      name: "bivy-eph-1",
      region: "nbg1",
      status: "starting",
      ip: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    await machines.add(machine); // previously threw "object store not found"

    const listed = await machines.list();
    expect(listed.map((m) => m.id)).toContain("eph-1");

    // The token is still readable from its own store after the split.
    expect(await keys.getToken("hetzner")).toBe("tok_abc");
  });
});

describe("ephemeral setup store", () => {
  it("keeps multiple named configurations per provider", async () => {
    const setups = createEphemeralSetupStore(memoryBackend());
    const eu = await setups.create("hetzner", { name: "EU node", region: "hel1", size: "cpx31", ttlMinutes: 180 });
    const us = await setups.create("hetzner", { name: "US node", region: "ash", ttlMinutes: 60 });
    await setups.create("fly", { name: "Fly backup", region: "lhr" });

    expect((await setups.list("hetzner")).map((s) => s.name)).toEqual(["EU node", "US node"]);
    expect((await setups.get(eu.id))?.size).toBe("cpx31");
    await setups.update(us.id, { name: "US fast node", size: "cpx41" });
    expect((await setups.get(us.id))?.name).toBe("US fast node");
    await setups.remove(eu.id);
    expect(await setups.get(eu.id)).toBeNull();
    await expect(setups.create("nope", { name: "Bad" })).rejects.toThrow();
    await expect(setups.create("fly", { name: "  " })).rejects.toThrow("name");
  });
});

describe("ephemeral preferences store (real IDB)", () => {
  it("defaults to no preferences, merges patches, and persists per provider", async () => {
    const prefs = createEphemeralPrefsStore();

    // Unset provider → all-null (fall back to adapter defaults).
    expect(await prefs.get("hetzner")).toEqual({ region: null, size: null, ttlMinutes: null, repo: null, teardownOnAgentFinish: false });

    // Partial set leaves the untouched fields null…
    await prefs.set("hetzner", { region: "hel1", ttlMinutes: 180 });
    expect(await prefs.get("hetzner")).toEqual({ region: "hel1", size: null, ttlMinutes: 180, repo: null, teardownOnAgentFinish: false });

    // …and a later patch merges rather than replacing.
    await prefs.set("hetzner", { size: "cpx31", repo: "owner/name" });
    expect(await prefs.get("hetzner")).toEqual({ region: "hel1", size: "cpx31", ttlMinutes: 180, repo: "owner/name", teardownOnAgentFinish: false });

    // Preferences are namespaced per provider.
    expect(await prefs.get("fly")).toEqual({ region: null, size: null, ttlMinutes: null, repo: null, teardownOnAgentFinish: false });

    // Remove clears them.
    await prefs.remove("hetzner");
    expect(await prefs.get("hetzner")).toEqual({ region: null, size: null, ttlMinutes: null, repo: null, teardownOnAgentFinish: false });

    // Unknown providers are rejected on write, ignored on read/remove.
    await expect(prefs.set("nope", { region: "x" })).rejects.toThrow();
    expect(await prefs.get("nope")).toEqual({ region: null, size: null, ttlMinutes: null, repo: null, teardownOnAgentFinish: false });
  });
});
