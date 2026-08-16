// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { ephemeralComputeIntent, ephemeralComputeIntentLabel } from "../src/ephemeral-compute.js";
import { EPHEMERAL_PROVIDER_ADAPTERS } from "../src/ephemeral-provider-registry.js";

describe("ephemeral compute intents", () => {
  it.each([
    [{ id: "tiny", label: "tiny", vcpus: 2, memoryMiB: 4096 }, "quick"],
    [{ id: "normal", label: "normal", vcpus: 4, memoryMiB: 8192 }, "standard"],
    [{ id: "large", label: "large", vcpus: 8, memoryMiB: 32768 }, "large"],
    [{ id: "memory", label: "memory", vcpus: 8, memoryMiB: 65536 }, "memory"],
    [{ id: "gpu", label: "gpu", vcpus: 4, memoryMiB: 8192, accelerator: { vendor: "nvidia", model: "L4", count: 1 } }, "gpu"],
  ] as const)("classifies %s as %s", (size, intent) => {
    expect(ephemeralComputeIntent(size)).toBe(intent);
  });

  it("does not optimistically classify missing facts", () => {
    expect(ephemeralComputeIntent({ id: "unknown", label: "Unknown" })).toBe("quick");
    expect(ephemeralComputeIntentLabel({ id: "x", label: "x", vcpus: 4, memoryMiB: 8192 })).toBe("Standard");
  });

  it("publishes structured facts and an agent-fit default for every adapter", () => {
    for (const adapter of EPHEMERAL_PROVIDER_ADAPTERS) {
      for (const size of adapter.sizes) {
        expect(size.vcpus, `${adapter.id}/${size.id} vcpus`).toBeGreaterThan(0);
        expect(size.memoryMiB, `${adapter.id}/${size.id} memory`).toBeGreaterThan(0);
        expect(size.architecture, `${adapter.id}/${size.id} architecture`).toMatch(/^(x86_64|arm64)$/);
      }
      const selected = adapter.sizes.find((size) => size.id === adapter.defaultSize);
      expect(selected, `${adapter.id} default exists`).toBeDefined();
      expect(ephemeralComputeIntent(selected!), `${adapter.id} default intent`).toBe("standard");
    }
  });
});
