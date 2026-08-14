// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { EPHEMERAL_PROVIDERS } from "../src/ephemeral-catalog.js";
import { EPHEMERAL_PROVIDER_ADAPTERS, ephemeralAdapter } from "../src/ephemeral-provider-registry.js";

describe("ephemeral provider registry", () => {
  it("composes one interpreter for every catalog provider", () => {
    const adapterIds = EPHEMERAL_PROVIDER_ADAPTERS.map(({ id }) => id);
    expect(new Set(adapterIds).size).toBe(adapterIds.length);
    expect([...adapterIds].sort()).toEqual(EPHEMERAL_PROVIDERS.map(({ id }) => id).sort());
  });

  it("indexes the composed interpreters through the compatibility lookup", () => {
    for (const adapter of EPHEMERAL_PROVIDER_ADAPTERS) {
      expect(ephemeralAdapter(`  ${adapter.id.toUpperCase()}  `)).toBe(adapter);
    }
    expect(ephemeralAdapter("unknown")).toBeNull();
  });
});
