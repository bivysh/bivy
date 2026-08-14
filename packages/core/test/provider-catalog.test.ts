// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { describe, expect, it } from "vitest";
import {
  BIVY_API_KEY_PROVIDER_IDS,
  BIVY_PROVIDER_CATALOG,
  BIVY_PROVIDER_CATALOG_VERSION,
  bivyProvider,
  searchBivyProviders,
} from "../src/index.js";

describe("Bivy provider catalog", () => {
  it("has a version, unique stable identities, auth methods, and valid models", () => {
    expect(BIVY_PROVIDER_CATALOG_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(new Set(BIVY_PROVIDER_CATALOG.map((provider) => provider.id)).size).toBe(BIVY_PROVIDER_CATALOG.length);
    for (const provider of BIVY_PROVIDER_CATALOG) {
      expect(provider.id).toMatch(/^[a-z0-9-]+$/);
      expect(provider.authMethods.length).toBeGreaterThan(0);
      expect(new Set(provider.models.map((model) => model.id)).size).toBe(provider.models.length);
    }
  });

  it("resolves aliases and searches without a node", () => {
    expect(bivyProvider(" CODEX ")?.id).toBe("openai-codex");
    expect(searchBivyProviders("gemini").map((provider) => provider.id)).toContain("google");
  });

  it("exports API-key providers and a useful baseline model snapshot", () => {
    expect(BIVY_API_KEY_PROVIDER_IDS).toContain("anthropic");
    expect(BIVY_API_KEY_PROVIDER_IDS).not.toContain("openai-codex");
    expect(bivyProvider("anthropic")?.models.length).toBeGreaterThan(0);
    expect(bivyProvider("openai")?.models.some((model) => model.id === "gpt-5.4")).toBe(true);
  });
});
