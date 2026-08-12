// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { describe, expect, it } from "vitest";
import { ephemeralCostEstimate, ephemeralLifecyclePhase } from "../src/ephemeral.js";

describe("ephemeral lifecycle UX", () => {
  it("derives durable phases and prioritizes teardown failure", () => {
    expect(ephemeralLifecyclePhase({})).toBe("provisioning");
    expect(ephemeralLifecyclePhase({ milestones: { nodeReadyAt: "x" } })).toBe("hydrating");
    expect(ephemeralLifecyclePhase({ purpose: "ready-capacity", milestones: { nodeReadyAt: "x", credentialsReadyAt: "y" } })).toBe("ready");
    expect(ephemeralLifecyclePhase({ claimedAt: "z", milestones: { nodeReadyAt: "x", credentialsReadyAt: "y" } })).toBe("claimed");
    expect(ephemeralLifecyclePhase({ milestones: { firstAgentEventAt: "z" } })).toBe("working");
    expect(ephemeralLifecyclePhase({ milestones: { firstAgentEventAt: "z" } }, true)).toBe("teardown-failed");
  });

  it("caps accrued estimate at the configured TTL", () => {
    const size = { id: "x", label: "x", pricePerHour: 0.12 };
    const createdAt = "2026-01-01T00:00:00.000Z";
    const halfway = ephemeralCostEstimate(size, createdAt, 60, Date.parse("2026-01-01T00:30:00.000Z"));
    expect(halfway?.accrued).toBeCloseTo(0.06);
    expect(halfway?.maximum).toBeCloseTo(0.12);
    const capped = ephemeralCostEstimate(size, createdAt, 60, Date.parse("2026-01-01T02:00:00.000Z"));
    expect(capped?.accrued).toBeCloseTo(0.12);
    expect(capped?.maximum).toBeCloseTo(0.12);
  });
});
