// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { launchModels, launchModelUnavailableError } from "../src/launch-models.js";

describe("pre-launch model catalog", () => {
  it("works without a machine and deduplicates account credentials", () => {
    const models = launchModels(["anthropic", "anthropic", "codex"]);
    expect(models.some(model => model.provider === "anthropic")).toBe(true);
    expect(models.some(model => model.provider === "openai-codex")).toBe(true);
    expect(models.every(model => model.configured === true)).toBe(true);
    expect(new Set(models.map(model => `${model.provider}/${model.id}`)).size).toBe(models.length);
  });

  it("does not inherit another machine's authentication", () => {
    expect(launchModels([], [{ id: "private", provider: "openai", configured: true }])).toEqual([]);
  });

  it("augments the baseline with discovered and custom models for accessible providers", () => {
    const models = launchModels(["anthropic", "custom"], [
      { id: "claude-opus-4-8", label: "Runtime label", provider: "anthropic", current: true },
      { id: "local-model", provider: "custom", configured: false },
      { id: "unknown", provider: "custom" },
      { id: "custom", provider: "custom", configured: false, modelCount: 12 },
    ]);
    expect(models.filter(model => model.id === "claude-opus-4-8")).toEqual([
      { id: "claude-opus-4-8", label: "Runtime label", provider: "anthropic", configured: true, current: false },
    ]);
    expect(models.find(model => model.id === "local-model")?.configured).toBe(true);
    expect(models.some(model => model.id === "unknown" || model.modelCount != null)).toBe(false);
  });
});

describe("saved-model unavailable diagnosis", () => {
  const saved = { id: "claude-fable-5", provider: "anthropic" };

  it("distinguishes a missing model id from a missing provider", () => {
    const withProvider = launchModelUnavailableError(saved, [{ id: "claude-sonnet-4-5", provider: "anthropic" }], true);
    expect(withProvider).toBe("Your saved model isn't available on this machine. Choose another model.");
    const withoutProvider = launchModelUnavailableError(saved, [{ id: "gpt-test", provider: "openai-codex" }], true);
    expect(withoutProvider).toContain("its anthropic credential didn't reach Bivy Cloud");
    expect(withoutProvider).toContain("unattended-runs grant");
  });

  it("points user-owned machines at connecting the provider, not the Cloud grant", () => {
    const error = launchModelUnavailableError(saved, [], false);
    expect(error).toContain("no anthropic credential is connected here");
    expect(error).not.toContain("Bivy Cloud");
  });
});
