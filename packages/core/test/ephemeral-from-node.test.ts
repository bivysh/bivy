// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { describe, expect, it } from "vitest";
import { ephemeralMachineFromNode, isEphemeralNode } from "../src/index.js";

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

describe("isEphemeralNode (persistent nodes must not enter the ephemeral resume path)", () => {
  it("recognises an ephemeral node by its eph-* id alone", () => {
    expect(isEphemeralNode({ id: "eph-abc123" })).toBe(true);
  });

  it("recognises an ephemeral node by its control-plane identity block alone", () => {
    // A non-`eph-` id but a populated ephemeral block still counts.
    expect(isEphemeralNode({ id: "node-1", ephemeral: { provider: "sprites", machineId: "m" } })).toBe(true);
  });

  it("returns false for a persistent node (no eph- id, no ephemeral block)", () => {
    expect(isEphemeralNode({ id: "node-1", name: "laptop" } as { id: string })).toBe(false);
  });

  it("returns false for an offline persistent node so a send does not trigger an impossible rebuild", () => {
    // Regression: an offline persistent node was misclassified as resumable and
    // swept into reprovisionEphemeral, throwing "No record of the machine to rebuild".
    expect(isEphemeralNode({ id: "srv-prod-01" } as { id: string })).toBe(false);
  });

  it("returns false when the ephemeral block is incomplete on a non-eph- id", () => {
    expect(isEphemeralNode({ id: "node-2", ephemeral: { provider: "sprites" } })).toBe(false);
    expect(isEphemeralNode({ id: "node-3", ephemeral: { machineId: "sbx" } })).toBe(false);
  });
});
