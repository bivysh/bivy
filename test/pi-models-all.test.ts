import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PiRuntime } from "../src/runtime/pi.js";
import { createCredentialVault } from "../src/runtime/credential-store.js";

// #390: the model picker must be able to show every model the runtime
// supports — not just the ones already connected — so the user can discover
// and connect a new provider inline. getModels() (connected/available) stays
// unchanged; getAllModels() is the new, additive surface the picker's "other
// models" section is built from, and it must flag exactly which of those are
// already configured vs. not.

const piDir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-pi-models-all-"));
const sessionsDir = path.join(piDir, "sessions");
fs.mkdirSync(sessionsDir, { recursive: true });

// Only Anthropic is signed in.
const store = createCredentialVault(piDir);
await store.modify("anthropic", async () => ({ type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3_600_000 }));

// Catalog-network behavior is covered by the upstream runtime; this unit test
// only exercises local auth/config reloads and must not depend on the network.
const runtime = new PiRuntime({ credsDir: piDir, piDir, sessionsDir, allowModelNetwork: false });
const { session } = await runtime.createSession({ workspace: piDir });

assert.equal(typeof session.getAllModels, "function", "PiSession must implement the optional getAllModels() capability");

const available = await session.getModels();
const all = await session.getAllModels!();

// getModels() (today's "connected" list) is untouched: only Anthropic.
assert.ok(available.length > 0, "expected at least one connected model");
assert.ok(available.every((m) => m.provider === "anthropic"), "getModels() must stay connected-only");

// getAllModels() is a strict superset spanning many providers, most of them
// unconfigured — this is the catalog the picker's "other models" section
// diffs against the connected list.
assert.ok(all.length > available.length, "getAllModels() must include unconnected providers too");
const allProviders = new Set(all.map((m) => m.provider));
assert.ok(allProviders.has("anthropic"), "getAllModels() must still include the connected provider");
assert.ok(allProviders.has("openai"), "getAllModels() must include an unconnected provider like openai");

// Every model is correctly flagged: connected iff its provider is Anthropic.
for (const model of all) {
  const expectedConfigured = model.provider === "anthropic";
  assert.equal(
    model.configured,
    expectedConfigured,
    `expected ${model.provider}:${model.id}.configured === ${expectedConfigured}`,
  );
}

// Simulate the user connecting OpenAI's Codex OAuth mid-session (same shape as
// the existing auth-refresh regression test): getAllModels() must flip that
// provider's models from unconfigured to configured without a session restart.
await store.modify("openai-codex", async () => ({ type: "oauth", access: "c", refresh: "r", expires: Date.now() + 3_600_000 }));

const afterConnect = await session.getAllModels!();
const codexModels = afterConnect.filter((m) => m.provider === "openai-codex");
assert.ok(codexModels.length > 0, "expected at least one openai-codex model in the catalog");
assert.ok(codexModels.every((m) => m.configured === true), "openai-codex models must flip to configured after sign-in");
// Untouched providers keep reporting their prior state.
assert.ok(
  afterConnect.filter((m) => m.provider === "openai").every((m) => m.configured === false),
  "an unrelated provider must remain unconfigured",
);

// A custom endpoint can be added while this exact session remains open. Pi's
// ModelRuntime loaded models.json at session creation, so the daemon must ask it
// to reload in place; replacing some unrelated active/scratch session does not
// update the sessionId the picker is querying.
await store.modify("hetzner-inference", async () => ({ type: "api_key", key: "test-key" }));
fs.writeFileSync(path.join(piDir, "models.json"), JSON.stringify({
  providers: {
    "hetzner-inference": {
      name: "Hetzner inference",
      baseUrl: "https://inference.hetzner.com/api/v1",
      api: "openai-completions",
      apiKey: "test-key",
      models: [{ id: "test-model", name: "Test model" }],
    },
  },
}));
assert.equal(
  (await session.getAllModels!()).some((m) => m.provider === "hetzner-inference"),
  false,
  "the already-open session starts with its pre-save catalog",
);
assert.equal(typeof session.refreshModels, "function", "PiSession must support in-place model catalog refresh");
await session.refreshModels!();
assert.ok(
  (await session.getModels()).some((m) => m.provider === "hetzner-inference" && m.id === "test-model"),
  "refreshModels must expose a newly-saved custom model on the already-open session",
);

session.dispose();
fs.rmSync(piDir, { recursive: true, force: true });

console.log("pi getAllModels OK (catalog auth and custom models refresh in an open session)");
