// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { describe, expect, it } from "vitest";
import * as ephemeralPublic from "../src/ephemeral.js";
import { createEphemeralExecutionEnvelope } from "../src/ephemeral-execution-envelope.js";
import {
  planEphemeralLaunch,
  trackProvisionedMachine,
  type EphemeralMachine,
} from "../src/ephemeral.js";

const input = {
  provider: "fly",
  attemptId: "attempt-1",
  nodeId: "eph-ab12",
  requestedAt: "2026-01-01T00:00:00.000Z",
  defaultRegion: "iad",
  defaultSize: "shared-cpu-2x",
};

describe("ephemeral launch plan values", () => {
  it("derives safe provider intent without performing effects", () => {
    const plan = planEphemeralLaunch({
      ...input,
      repo: "bivysh/bivy",
      name: "EU worker",
      region: "ams",
    });
    expect(plan).toMatchObject({
      attemptId: "attempt-1",
      nodeId: "eph-ab12",
      region: "ams",
      size: "shared-cpu-2x",
      providerConfig: { slug: "ab12", region: "ams", attemptId: "attempt-1" },
      machineFacts: { name: "EU worker", repo: "bivysh/bivy" },
    });
  });

  it("keeps secret bootstrap material in a separate execution envelope", () => {
    expect(ephemeralPublic.createEphemeralExecutionEnvelope).toBe(createEphemeralExecutionEnvelope);
    const plan = planEphemeralLaunch(input);
    const envelope = createEphemeralExecutionEnvelope({
      provider: plan.provider,
      nodeId: plan.nodeId,
      relayUrl: "wss://relay.example",
      controlPlaneUrl: "https://app.example",
      enrollmentToken: "enroll-secret",
      roomKeyB64: "room-secret",
      githubToken: "github-secret",
      hostedTasks: true,
    });
    expect(plan).not.toHaveProperty("bootstrap");
    expect(JSON.stringify(plan)).not.toContain("secret");
    expect(envelope.bootstrap).toMatchObject({
      enrollmentToken: "enroll-secret",
      e2eKeyB64: "room-secret",
      githubToken: "github-secret",
      nodeLabel: "ab12",
    });
  });

  it("projects a provider result into a new tracked value", () => {
    const plan = planEphemeralLaunch({ ...input, setupId: "setup-1", purpose: "queue-item" });
    const providerMachine: EphemeralMachine = {
      id: "machine-1",
      provider: "fly",
      name: "provider-name",
      region: "iad",
      status: "starting",
      ip: null,
      createdAt: input.requestedAt,
    };
    const tracked = trackProvisionedMachine(providerMachine, plan, "2026-01-01T00:00:05.000Z");
    expect(providerMachine).not.toHaveProperty("nodeId");
    expect(tracked).toMatchObject({
      id: "machine-1",
      attemptId: "attempt-1",
      nodeId: "eph-ab12",
      setupId: "setup-1",
      purpose: "queue-item",
      milestones: {
        requestedAt: input.requestedAt,
        providerAcceptedAt: "2026-01-01T00:00:05.000Z",
      },
    });
  });
});
