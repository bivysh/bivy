// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { describe, expect, it } from "vitest";
import { ephemeralColdStartMs } from "../src/ephemeral.js";

describe("ephemeral cold-start SLO", () => {
  it("measures request to first agent event", () => {
    expect(ephemeralColdStartMs({ milestones: {
      requestedAt: "2026-08-12T00:00:00.000Z",
      providerAcceptedAt: "2026-08-12T00:00:01.000Z",
      firstAgentEventAt: "2026-08-12T00:00:09.500Z",
    } })).toBe(9_500);
  });

  it("does not mistake provider acceptance for agent readiness", () => {
    expect(ephemeralColdStartMs({ milestones: {
      requestedAt: "2026-08-12T00:00:00.000Z",
      providerAcceptedAt: "2026-08-12T00:00:01.000Z",
    } })).toBeUndefined();
  });
});
