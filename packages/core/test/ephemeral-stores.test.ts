// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { createEphemeralKeyStore, createMachineStore, type EphemeralMachine } from "../src/ephemeral-storage.js";

// Regression: the provider-key store and the machine store used to share one
// IndexedDB database opened at a fixed version, so `onupgradeneeded` only ran
// for whichever store opened first. Saving a token created the DB with just the
// provider-keys store, and the later machine write then failed with
// "object store not found". Each store now owns its own database.
describe("ephemeral IndexedDB stores coexist (real IDB)", () => {
  it("adds a machine even after the key store creates its DB first", async () => {
    const keys = createEphemeralKeyStore();
    await keys.setToken("fly", "tok_abc"); // creates the provider-keys DB first

    const machines = createMachineStore();
    const machine: EphemeralMachine = {
      id: "eph-1",
      provider: "fly",
      name: "bivy-eph-1",
      region: "iad",
      status: "starting",
      ip: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    await machines.add(machine); // previously threw "object store not found"

    const listed = await machines.list();
    expect(listed.map((m) => m.id)).toContain("eph-1");

    // The token is still readable from its own store after the split.
    expect(await keys.getToken("fly")).toBe("tok_abc");
  });
});
