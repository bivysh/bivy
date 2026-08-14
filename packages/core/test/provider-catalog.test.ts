// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { describe, expect, it } from "vitest";
import { BIVY_PROVIDER_CATALOG, BIVY_PROVIDER_CATALOG_VERSION, bivyProvider, searchBivyProviders } from "../src/index.js";

describe("Bivy provider catalog", () => {
  it("has stable unique identities and declared auth methods", () => {
    expect(BIVY_PROVIDER_CATALOG_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(new Set(BIVY_PROVIDER_CATALOG.map((provider) => provider.id)).size).toBe(BIVY_PROVIDER_CATALOG.length);
    expect(BIVY_PROVIDER_CATALOG.every((provider) => provider.authMethods.length > 0)).toBe(true);
  });

  it("resolves aliases and searches without a node", () => {
    expect(bivyProvider("codex")?.id).toBe("openai-codex");
    expect(searchBivyProviders("gemini").map((provider) => provider.id)).toContain("google");
  });

  it("ships a useful baseline model snapshot", () => {
    expect(bivyProvider("anthropic")?.models.length).toBeGreaterThan(0);
    expect(bivyProvider("openai")?.models.some((model) => model.id === "gpt-5.4")).toBe(true);
  });
});
