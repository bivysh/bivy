// Tests for the unified model catalog aggregator (src/runtime/model-catalog.ts):
// union across agents, dedupe by model, and vault auth status — pi is just one
// contributor.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCredentialVault } from "../src/runtime/credential-store.js";
import { aggregateModelCatalog, mergeProviderCatalog } from "../src/runtime/model-catalog.js";
import { BIVY_PROVIDER_CATALOG as nodeProviderCatalog, BIVY_PROVIDER_CATALOG_VERSION } from "../src/runtime/bivy-provider-catalog.js";
import { BIVY_PROVIDER_CATALOG as webProviderCatalog } from "../packages/core/src/provider-catalog.js";
import { ProcessRuntime } from "../src/runtime/process.js";
import type { AgentRuntime, CatalogProvider } from "../src/runtime/types.js";

let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${(error as Error).stack ?? (error as Error).message}`);
  }
}

assert.deepEqual(nodeProviderCatalog, webProviderCatalog, "node and browser provider-catalog projections stay identical");

function fakeRuntime(id: string, catalog: CatalogProvider[] | (() => Promise<CatalogProvider[]>)): AgentRuntime {
  return { id, listCatalog: typeof catalog === "function" ? catalog : () => catalog } as unknown as AgentRuntime;
}

await check("unions providers across agents, dedupes models, records contributing agents", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-catalog-"));
  const claude = fakeRuntime("claude-code-sdk", [
    { id: "anthropic", name: "Anthropic", oauth: true, models: [{ provider: "anthropic", id: "claude-opus-4-8", name: "Claude Opus 4.8" }] },
  ]);
  const pi = fakeRuntime("pi", [
    // Same provider + one overlapping model + one new one.
    { id: "anthropic", name: "Anthropic", oauth: true, models: [
      { provider: "anthropic", id: "claude-opus-4-8", name: "Claude Opus 4.8" },
      { provider: "anthropic", id: "claude-sonnet-5", name: "Claude Sonnet 5" },
    ] },
    { id: "openai", name: "OpenAI", models: [{ provider: "openai", id: "gpt-5", name: "GPT-5" }] },
  ]);

  const catalog = await aggregateModelCatalog([claude, pi], dir);
  const anthropic = catalog.find((p) => p.id === "anthropic")!;
  assert.deepEqual(anthropic.agents.sort(), ["claude-code-sdk", "pi"], "both agents recorded for anthropic");
  assert.equal(anthropic.models.filter((model) => model.id === "claude-opus-4-8").length, 1, "overlapping live model deduped by id");
  assert.ok(anthropic.models.some((model) => model.id === "claude-sonnet-5"), "live models extend the Bivy baseline");
  assert.ok(anthropic.oauth, "anthropic is an OAuth provider");
  assert.equal(anthropic.provenance?.baselineVersion, BIVY_PROVIDER_CATALOG_VERSION);
  assert.deepEqual(anthropic.provenance?.runtimeIds.sort(), ["claude-code-sdk", "pi"]);
  assert.ok(anthropic.provenance?.refreshedAt, "live overlay carries freshness metadata");
  assert.ok(catalog.find((p) => p.id === "openai"), "a provider only one agent offers still appears");
});

await check("stamps vault auth status and native-OAuth capability onto providers", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-catalog-"));
  await createCredentialVault(dir).modify("openai", async () => ({ type: "api_key", key: "sk-1" }));
  const agent = fakeRuntime("pi", [
    { id: "openai", name: "OpenAI", models: [] },
    { id: "xai", name: "xAI", models: [] },
    { id: "cohere", name: "Cohere", models: [] },
  ]);

  const catalog = await aggregateModelCatalog([agent], dir);
  assert.equal(catalog.find((p) => p.id === "openai")!.configured, true, "provider with a stored key is configured");
  assert.equal(catalog.find((p) => p.id === "xai")!.configured, false, "provider without a credential is unconfigured");
  assert.equal(catalog.find((p) => p.id === "xai")!.oauth, true, "xai is flagged OAuth from Bivy's native registry");
  assert.equal(catalog.find((p) => p.id === "cohere")!.oauth, false, "an api-key-only provider is not flagged OAuth");
});

await check("a runtime with no listCatalog (or that throws) is skipped, not fatal", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-catalog-"));
  const noCatalog = { id: "plain" } as unknown as AgentRuntime;
  const thrower = fakeRuntime("broken", async () => { throw new Error("offline"); });
  const ok = fakeRuntime("pi", [{ id: "openai", name: "OpenAI", models: [] }]);
  const catalog = await aggregateModelCatalog([noCatalog, thrower, ok], dir);
  assert.ok(catalog.length > 1, "the Bivy baseline remains available when runtimes fail");
  assert.ok(catalog.some((provider) => provider.id === "openai"));
  assert.deepEqual(catalog.find((provider) => provider.id === "openai")?.agents, ["pi"], "the healthy runtime still overlays the baseline");
});

await check("mergeProviderCatalog keeps base auth status, attaches agents/models, appends extra providers", async () => {
  const base = [
    { id: "anthropic", name: "Anthropic", oauth: true, configured: true, kind: "oauth" as const, source: "stored" },
    { id: "openai", name: "OpenAI", oauth: false, configured: false },
  ];
  const catalog = [
    { id: "anthropic", name: "Anthropic", oauth: true, configured: true, agents: ["pi", "claude-code-sdk"], models: [{ provider: "anthropic", id: "claude-opus-4-8", name: "Claude Opus 4.8" }] },
    { id: "xai", name: "xAI", oauth: true, configured: false, agents: ["pi"], models: [] },
  ];
  const merged = mergeProviderCatalog(base, catalog);
  const anthropic = merged.find((p) => p.id === "anthropic")!;
  assert.equal(anthropic.source, "stored", "base auth status is preserved");
  assert.deepEqual(anthropic.agents, ["pi", "claude-code-sdk"], "contributing agents attached from the catalog");
  assert.equal(anthropic.models.length, 1);
  assert.deepEqual(merged.find((p) => p.id === "openai")!.agents, [], "a base provider absent from the catalog gets empty agents");
  assert.ok(merged.find((p) => p.id === "xai"), "a catalog-only provider is appended");
});

await check("ProcessRuntime.listCatalog groups its configured models by provider", async () => {
  const runtime = new ProcessRuntime({
    id: "goose",
    displayName: "Goose",
    command: "true",
    model: {
      models: [
        { provider: "openai", id: "gpt-5", name: "GPT-5" },
        { provider: "openai", id: "o3", name: "o3" },
        { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
      ],
      modelArgs: () => [],
    },
  });
  const catalog = runtime.listCatalog();
  assert.equal(catalog.length, 2, "two distinct providers");
  assert.equal(catalog.find((p) => p.id === "openai")!.models.length, 2, "both openai models grouped");
});

if (failures > 0) {
  console.error(`model-catalog: ${failures} test(s) failed`);
  process.exit(1);
}
console.log("model-catalog: all tests passed");
