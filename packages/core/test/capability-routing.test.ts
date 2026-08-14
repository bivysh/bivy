// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { describe, it, expect } from "vitest";
import {
  validateCapabilityTags,
  matchCapabilities,
  anyNodeEligible,
  explainCapabilityMatch,
  capabilityClaimDelayMs,
  MAX_CAPABILITY_TAGS,
} from "../src/capability-routing.js";

describe("validateCapabilityTags", () => {
  it("accepts an empty/undefined declaration", () => {
    expect(validateCapabilityTags(undefined)).toEqual({ ok: true, tags: [], errors: [] });
  });

  it("accepts lowercase slugs and dedupes", () => {
    const result = validateCapabilityTags(["gpu", "docker", "gpu"]);
    expect(result.ok).toBe(true);
    expect(result.tags).toEqual(["gpu", "docker"]);
  });

  it("rejects a non-array value", () => {
    const result = validateCapabilityTags("gpu");
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/must be a list/);
  });

  it("rejects uppercase, spaces, and empty strings", () => {
    for (const bad of ["GPU", "has gpu", "", "-gpu", "gpu_docker"]) {
      const result = validateCapabilityTags([bad]);
      expect(result.ok).toBe(false);
    }
  });

  it("rejects a non-string entry without throwing", () => {
    const result = validateCapabilityTags([42, null, { a: 1 }]);
    expect(result.ok).toBe(false);
    expect(result.tags).toEqual([]);
  });

  it("caps the tag count", () => {
    const many = Array.from({ length: MAX_CAPABILITY_TAGS + 1 }, (_, i) => `tag-${i}`);
    const result = validateCapabilityTags(many);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes(`at most ${MAX_CAPABILITY_TAGS}`))).toBe(true);
  });
});

describe("matchCapabilities", () => {
  it("is eligible with no requirements at all", () => {
    const match = matchCapabilities(undefined, undefined, undefined);
    expect(match.eligible).toBe(true);
    expect(match.score).toBe(0);
  });

  it("blocks on a missing required tag (hard block)", () => {
    const match = matchCapabilities(["docker"], ["gpu"], undefined);
    expect(match.eligible).toBe(false);
    expect(match.missingRequired).toEqual(["gpu"]);
  });

  it("is eligible when every required tag is present, regardless of extras", () => {
    const match = matchCapabilities(["gpu", "docker", "extra"], ["gpu", "docker"], undefined);
    expect(match.eligible).toBe(true);
    expect(match.missingRequired).toEqual([]);
  });

  it("preferred tags never gate eligibility, only score", () => {
    const noneMatched = matchCapabilities(["docker"], undefined, ["gpu", "private-net"]);
    expect(noneMatched.eligible).toBe(true);
    expect(noneMatched.score).toBe(0);
    expect(noneMatched.unmatchedPreferred).toEqual(["gpu", "private-net"]);

    const someMatched = matchCapabilities(["docker", "gpu"], undefined, ["gpu", "private-net"]);
    expect(someMatched.eligible).toBe(true);
    expect(someMatched.score).toBe(1);
    expect(someMatched.matchedPreferred).toEqual(["gpu"]);
  });

  it("required and preferred combine independently", () => {
    const match = matchCapabilities(["docker"], ["docker"], ["gpu"]);
    expect(match.eligible).toBe(true);
    expect(match.score).toBe(0);
    expect(match.unmatchedPreferred).toEqual(["gpu"]);
  });
});

describe("anyNodeEligible (required-tag parking honesty)", () => {
  it("is true when at least one machine — online or offline — has ever declared the tag", () => {
    // "Offline machines": a node that asserted the capability but is not
    // currently reachable should still make the request honestly "waiting",
    // not "no eligible machine exists".
    expect(anyNodeEligible([["docker"], ["gpu"]], ["gpu"])).toBe(true);
  });

  it("is false when literally no machine has ever declared the required tag", () => {
    // Nothing to wait for — park instead of queuing forever.
    expect(anyNodeEligible([["docker"], ["docker"]], ["gpu"])).toBe(false);
    expect(anyNodeEligible([], ["gpu"])).toBe(false);
  });

  it("is vacuously true with no required tags", () => {
    expect(anyNodeEligible([], undefined)).toBe(true);
    expect(anyNodeEligible([], [])).toBe(true);
  });

  it("honors a stale declaration the same as a fresh one — tags are assertions, not verified facts", () => {
    // matchCapabilities/anyNodeEligible take a plain capability list with no
    // "last seen"/"asserted at" concept at all — a stale declaration and a
    // fresh one are indistinguishable inputs, by design.
    const staleNodeCapabilities = ["gpu"];
    expect(anyNodeEligible([staleNodeCapabilities], ["gpu"])).toBe(true);
  });
});

describe("explainCapabilityMatch (privacy-safe, bounded)", () => {
  it("names only the missing tag on a hard block", () => {
    const match = matchCapabilities(["docker"], ["gpu"], undefined);
    const text = explainCapabilityMatch(match);
    expect(text).toBe("missing required capability: gpu");
  });

  it("never exceeds 200 characters", () => {
    const many = Array.from({ length: MAX_CAPABILITY_TAGS }, (_, i) => `preferred-tag-number-${i}`);
    const match = matchCapabilities([], undefined, many);
    expect(explainCapabilityMatch(match).length).toBeLessThanOrEqual(200);
  });

  it("contains no URL-shaped or secret-shaped substrings", () => {
    const match = matchCapabilities(["gpu"], ["gpu"], ["docker"]);
    const text = explainCapabilityMatch(match, { label: "my-gpu-box" });
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).not.toMatch(/token|secret|key|password/i);
  });

  it("reports matched and unmatched preferred tags separately when eligible", () => {
    const match = matchCapabilities(["gpu"], undefined, ["gpu", "docker"]);
    const text = explainCapabilityMatch(match);
    expect(text).toContain("matched preferred: gpu");
    expect(text).toContain("preferred unavailable: docker");
  });
});

describe("capabilityClaimDelayMs (soft preference ranking)", () => {
  it("never delays an ineligible node — it should not claim at all, not claim late", () => {
    const match = matchCapabilities(["docker"], ["gpu"], undefined);
    expect(capabilityClaimDelayMs(match)).toBe(0);
  });

  it("never delays when there is nothing preferred to rank on", () => {
    const match = matchCapabilities(["docker"], ["docker"], undefined);
    expect(capabilityClaimDelayMs(match)).toBe(0);
  });

  it("zero delay for a full preferred match", () => {
    const match = matchCapabilities(["gpu", "docker"], undefined, ["gpu", "docker"]);
    expect(capabilityClaimDelayMs(match)).toBe(0);
  });

  it("longer delay the fewer preferred tags are matched, capped at maxMs", () => {
    const none = matchCapabilities([], undefined, ["gpu", "docker"]);
    const half = matchCapabilities(["gpu"], undefined, ["gpu", "docker"]);
    const full = matchCapabilities(["gpu", "docker"], undefined, ["gpu", "docker"]);
    const delayNone = capabilityClaimDelayMs(none, { baseMs: 2000, maxMs: 4000 });
    const delayHalf = capabilityClaimDelayMs(half, { baseMs: 2000, maxMs: 4000 });
    const delayFull = capabilityClaimDelayMs(full, { baseMs: 2000, maxMs: 4000 });
    expect(delayFull).toBe(0);
    expect(delayHalf).toBeGreaterThan(delayFull);
    expect(delayNone).toBeGreaterThan(delayHalf);
    expect(delayNone).toBeLessThanOrEqual(4000);
  });

  it("is deterministic for identical inputs (no randomness)", () => {
    const match = matchCapabilities(["gpu"], undefined, ["gpu", "docker", "private-net"]);
    const a = capabilityClaimDelayMs(match);
    const b = capabilityClaimDelayMs(match);
    expect(a).toBe(b);
  });
});
