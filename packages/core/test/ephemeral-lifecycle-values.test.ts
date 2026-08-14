// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { describe, expect, it } from "vitest";
import {
  clampTtlMinutes,
  ephemeralColdStartMs,
  ephemeralCostEstimate,
  ephemeralLifecyclePhase,
} from "../src/ephemeral-lifecycle.js";

describe("pure ephemeral lifecycle values", () => {
  it("derives lifecycle from facts without provider or machine objects", () => {
    const facts = { purpose: "ready-capacity" as const, milestones: { nodeReadyAt: "n", credentialsReadyAt: "c" } };
    expect(ephemeralLifecyclePhase(facts)).toBe("ready");
    expect(ephemeralLifecyclePhase(facts, true)).toBe("teardown-failed");
  });

  it("derives cold-start duration from timestamps", () => {
    expect(ephemeralColdStartMs({
      milestones: {
        requestedAt: "2026-01-01T00:00:00.000Z",
        firstAgentEventAt: "2026-01-01T00:02:30.000Z",
      },
    })).toBe(150_000);
  });

  it("uses an explicit clock value for deterministic cost projections", () => {
    const result = ephemeralCostEstimate(
      { pricePerHour: 0.20 },
      "2026-01-01T00:00:00.000Z",
      60,
      Date.parse("2026-01-01T00:30:00.000Z"),
    );
    expect(result).toEqual({ accrued: 0.10, maximum: 0.20 });
  });

  it("normalizes TTL as a pure value transformation", () => {
    expect(clampTtlMinutes()).toBe(60);
    expect(clampTtlMinutes(1)).toBe(5);
    expect(clampTtlMinutes(10_000)).toBe(1_440);
  });
});
