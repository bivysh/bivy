// Tests for the unified model catalog aggregator (src/runtime/model-catalog.ts):
// union across agents, dedupe by model, and vault auth status — pi is just one
// contributor.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCredentialVault } from "../src/runtime/credential-store.js";
import { joinProviderCatalog } from "../src/credentials/api.js";
import { aggregateModelCatalog, mergeProviderCatalog } from "../src/runtime/model-catalog.js";
import { overlayProviderCatalog } from "../src/runtime/provider-catalog.js";
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
  assert.equal(anthropic.models.filter((model) => model.id === "claude-opus-4-8").length, 1, "overlapping model deduped by id");
  assert.ok(anthropic.models.some((model) => model.id === "claude-sonnet-5"), "live models extend the baseline");
  assert.ok(anthropic.oauth, "anthropic is an OAuth provider");
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

await check("ships the Bivy baseline when no runtime is installed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-catalog-"));
  const catalog = await aggregateModelCatalog([], dir);
  const openai = catalog.find((provider) => provider.id === "openai")!;
  assert.ok(openai, "baseline provider exists without an agent");
  assert.ok(openai.models.some((model) => model.id === "gpt-5.4"), "baseline models exist without an agent");
  assert.ok(openai.provenance.baselineVersion, "baseline version is retained as provenance");
  assert.deepEqual(openai.agents, []);
});

await check("a missing or failing runtime is skipped and live metadata overlays the baseline", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-catalog-"));
  const noCatalog = { id: "plain" } as unknown as AgentRuntime;
  const thrower = fakeRuntime("broken", async () => { throw new Error("offline"); });
  const ok = fakeRuntime("pi", [{
    id: "openai-api",
    name: "runtime name does not replace Bivy identity",
    models: [{ provider: "openai-api", id: "gpt-5.4", name: "GPT-5.4 (live)", contextWindow: 123 }],
  }]);
  const catalog = await aggregateModelCatalog([noCatalog, thrower, ok], dir);
  const openai = catalog.find((provider) => provider.id === "openai")!;
  assert.equal(openai.name, "OpenAI API");
  assert.equal(openai.models.find((model) => model.id === "gpt-5.4")!.contextWindow, 123, "live same-id model replaces stale metadata");
  assert.deepEqual(openai.provenance.runtimeIds, ["pi"]);
  assert.equal(typeof openai.provenance.refreshedAt, "number");
});

await check("mergeProviderCatalog keeps base auth status, attaches agents/models, appends extra providers", async () => {
  const base = [
    { id: "anthropic", name: "Anthropic", oauth: true, configured: true, kind: "oauth" as const, source: "stored" },
    { id: "openai", name: "OpenAI", oauth: false, configured: false },
  ];
  const catalog = [
    { id: "anthropic", name: "Anthropic", oauth: true, configured: true, agents: ["pi", "claude-code-sdk"], models: [{ provider: "anthropic", id: "claude-opus-4-8", name: "Claude Opus 4.8" }], provenance: { baselineVersion: "test", runtimeIds: ["pi", "claude-code-sdk"] } },
    { id: "xai", name: "xAI", oauth: true, configured: false, agents: ["pi"], models: [], provenance: { runtimeIds: ["pi"] } },
  ];
  const merged = mergeProviderCatalog(base, catalog);
  const anthropic = merged.find((p) => p.id === "anthropic")!;
  assert.equal(anthropic.source, "stored", "base auth status is preserved");
  assert.deepEqual(anthropic.agents, ["pi", "claude-code-sdk"], "contributing agents attached from the catalog");
  assert.equal(anthropic.models.length, 1);
  assert.equal(anthropic.provenance?.baselineVersion, "test", "catalog provenance is preserved");
  assert.deepEqual(merged.find((p) => p.id === "openai")!.agents, [], "a base provider absent from the catalog gets empty agents");
  assert.ok(merged.find((p) => p.id === "xai"), "a catalog-only provider is appended");
});

await check("baseline provider rows retain vault auth status without a live catalog", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-catalog-"));
  await createCredentialVault(dir).modify("openrouter", async () => ({ type: "api_key", key: "test" }));
  const [row] = await joinProviderCatalog(dir, [
    { id: "openrouter", name: "OpenRouter", oauth: false, configured: false },
  ]);
  assert.equal(row!.configured, true);
  assert.equal(row!.kind, "api_key");
  assert.equal(row!.source, "stored");
});

await check("provider baseline preserves live auth status/source and canonicalizes aliases", async () => {
  const catalog = overlayProviderCatalog([
    { id: "openai-api", name: "Other name", oauth: false, configured: true, source: "environment" },
    { id: "custom", name: "Custom", oauth: false, configured: false },
  ]);
  const openai = catalog.find((provider) => provider.id === "openai")!;
  assert.equal(openai.name, "OpenAI API");
  assert.equal(openai.configured, true);
  assert.equal(openai.source, "environment");
  assert.ok(catalog.find((provider) => provider.id === "custom"), "live-only provider is retained");
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
