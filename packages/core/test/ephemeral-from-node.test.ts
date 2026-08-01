// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { describe, expect, it } from "vitest";
import { ephemeralMachineFromNode } from "../src/index.js";

describe("ephemeralMachineFromNode (cross-device resume — Gap A)", () => {
  it("reconstructs a wakeable machine from a node's non-secret ephemeral identity", () => {
    const machine = ephemeralMachineFromNode({
      id: "eph-abc123",
      name: "my sprite",
      ephemeral: { provider: "sprites", machineId: "bivy-abc123", app: "bivy-abc123", region: "iad" },
    });
    expect(machine).toEqual({
      id: "bivy-abc123",
      provider: "sprites",
      name: "my sprite",
      region: "iad",
      status: "stopped",
      ip: null,
      createdAt: "",
      app: "bivy-abc123",
      nodeId: "eph-abc123",
    });
  });

  it("falls back to the machine id for the name and tolerates a missing app/region", () => {
    const machine = ephemeralMachineFromNode({
      id: "eph-x",
      ephemeral: { provider: "e2b", machineId: "sbx_1" },
    });
    expect(machine).toMatchObject({ id: "sbx_1", provider: "e2b", name: "sbx_1", region: "", app: undefined, nodeId: "eph-x" });
  });

  it("returns null for a persistent node (no ephemeral identity)", () => {
    expect(ephemeralMachineFromNode({ id: "node-1", name: "laptop" })).toBeNull();
  });

  it("returns null when the ephemeral block is incomplete (older control plane)", () => {
    expect(ephemeralMachineFromNode({ id: "eph-y", ephemeral: { provider: "sprites" } })).toBeNull();
    expect(ephemeralMachineFromNode({ id: "eph-z", ephemeral: { machineId: "sbx_2" } })).toBeNull();
  });

  it("marks the reconstructed machine as stopped so the resume path wakes it", () => {
    const machine = ephemeralMachineFromNode({ id: "eph-w", ephemeral: { provider: "sprites", machineId: "m" } });
    expect(machine?.status).toBe("stopped");
  });
});
