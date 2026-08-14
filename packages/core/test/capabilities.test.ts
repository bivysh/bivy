import { describe, expect, it } from "vitest";
import { describeCapabilityState, summarizeCapabilityStates } from "../src/capabilities.js";

describe("describeCapabilityState", () => {
  it("never conflates a capability probe with connection status", () => {
    expect(describeCapabilityState("available")).toBe("Available");
    expect(describeCapabilityState("unavailable")).toBe("Not available");
    expect(describeCapabilityState("unknown")).toBe("Unknown");
    for (const label of ["Available", "Not available", "Unknown"]) {
      expect(label).not.toMatch(/online|offline/i);
    }
  });
});

describe("summarizeCapabilityStates", () => {
  it("tallies each tri-state independently", () => {
    expect(summarizeCapabilityStates(["available", "available", "unknown", "unavailable"])).toEqual({
      available: 2, unavailable: 1, unknown: 1,
    });
  });

  it("returns all-zero counts for an empty list", () => {
    expect(summarizeCapabilityStates([])).toEqual({ available: 0, unavailable: 0, unknown: 0 });
  });
});
