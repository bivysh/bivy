import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PiRuntime, piSessionCommands } from "../src/runtime/pi.js";
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

// --- merged from pi-attach-env.test.ts ---
{
  const piDir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-pi-attach-env-"));
  const sessionsDir = path.join(piDir, "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });

  const runtime = new PiRuntime({ credsDir: piDir, piDir, sessionsDir });
  const { session } = await runtime.createSession({ workspace: piDir });

  // SessionManager.create() assigns a session file synchronously (before any
  // prompt), so a fresh session already has one to resume into the TUI.
  assert.ok(session.sessionFile, "expected a session file to already be assigned");

  const spec = await session.interactiveTuiCommand?.();
  assert.ok(spec, "expected a TUI launch spec");
  assert.equal(spec!.env?.BIVY_SESSION_ID, session.id, "BIVY_SESSION_ID must be in the TUI subprocess env, matching the session id");

  session.dispose();
  fs.rmSync(piDir, { recursive: true, force: true });

  console.log("pi-attach-env: ok");
}

// --- merged from pi-commands.test.ts ---
{
  // A fake AgentSession shaped like the Pi SDK's public accessors (extension
  // commands + prompt templates + skills). piSessionCommands must normalize names
  // to a leading slash, keep descriptions, prefix skills with "skill:", and dedupe.
  const fakeSession = {
    extensionRunner: {
      getRegisteredCommands: () => [
        { invocationName: "compact", description: "Compact the conversation." },
        { invocationName: "/model", description: "Already slashed." }, // extra slash normalized
        { invocationName: "", description: "dropped — empty name" },
        { invocationName: "compact", description: "dup — first wins" },
      ],
    },
    promptTemplates: [
      { name: "review", description: "Review the diff." },
      { name: "nodesc" },
    ],
    _resourceLoader: {
      getSkills: () => ({ skills: [{ name: "deep-research", description: "Research harness." }] }),
    },
  };

  const commands = piSessionCommands(fakeSession);
  assert.deepEqual(commands, [
    { name: "/compact", description: "Compact the conversation." },
    { name: "/model", description: "Already slashed." },
    { name: "/review", description: "Review the diff." },
    { name: "/nodesc" },
    { name: "/skill:deep-research", description: "Research harness." },
  ]);

  // Malformed / empty inputs degrade to [] rather than throwing.
  assert.deepEqual(piSessionCommands(undefined), []);
  assert.deepEqual(piSessionCommands({}), []);
  assert.deepEqual(piSessionCommands({ extensionRunner: { getRegisteredCommands: () => { throw new Error("boom"); } } }), []);

  console.log("pi-commands: all tests passed");
}

// --- merged from pi-models-auth-refresh.test.ts ---
{
  // Regression: a provider the user signs into *after* a session has started used
  // to never appear in that session's model picker. getModels() now re-resolves
  // availability against Bivy's credential store (ModelRuntime.getAvailable()), so
  // a Claude session open while the user signs into OpenAI/ChatGPT (OAuth) must
  // surface the new provider's models without a restart.

  const piDir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-pi-models-"));
  const sessionsDir = path.join(piDir, "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });

  // Start with only a Claude (Anthropic) OAuth login on the node.
  const store = createCredentialVault(piDir);
  await store.modify("anthropic", async () => ({ type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3_600_000 }));

  const runtime = new PiRuntime({ credsDir: piDir, piDir, sessionsDir });
  const { session } = await runtime.createSession({ workspace: piDir });

  const providersOf = async () => new Set((await session.getModels()).map((model) => model.provider));

  assert.ok((await providersOf()).has("anthropic"), "the Claude session must list Anthropic models");
  assert.ok(!(await providersOf()).has("openai-codex"), "OpenAI Codex is not signed in yet, so it must not be listed");

  // Simulate a mid-session OAuth sign-in to OpenAI/ChatGPT: the daemon's login
  // flow writes the new credential to Bivy's shared store while this session is
  // still open.
  await store.modify("openai-codex", async () => ({ type: "oauth", access: "c", refresh: "r", expires: Date.now() + 3_600_000 }));

  const after = await providersOf();
  assert.ok(after.has("openai-codex"), "the picker must surface OpenAI Codex models after the mid-session sign-in");
  assert.ok(after.has("anthropic"), "the existing Claude models must remain available");

  // The just-added provider's model must also be selectable, not just visible.
  const codexModel = (await session.getModels()).find((model) => model.provider === "openai-codex");
  assert.ok(codexModel, "expected at least one OpenAI Codex model");
  await session.setModel(codexModel!.provider, codexModel!.id);

  session.dispose();
  fs.rmSync(piDir, { recursive: true, force: true });

  console.log("pi models auth refresh OK (mid-session provider sign-in surfaces its models)");
}

// --- merged from pi-models-broken-provider.test.ts ---
{
  // One broken provider must not blank the whole model catalog. Pi's runtime
  // refreshes availability with a Promise.all across every provider's
  // credential read/auth check, so a single failing provider (an unavailable
  // pinned account, an unreachable custom endpoint) used to reject getModels()
  // wholesale — the picker showed "No models available." and a Cloud launch
  // waiting to validate its saved model dead-ended on the query timeout.
  // getModels() must degrade to per-provider listing and skip only the broken
  // provider; getAllModels() must tolerate the failed refresh the same way.

  const piDir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-pi-models-broken-"));
  const sessionsDir = path.join(piDir, "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });

  const store = createCredentialVault(piDir);
  await store.modify("anthropic", async () => ({ type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3_600_000 }));
  await store.putRecord({
    provider: "openai",
    label: "work",
    origin: "bivy",
    sync: "node",
    source: { kind: "stored", cred: { type: "api_key", key: "k" } },
  });

  const runtime = new PiRuntime({ credsDir: piDir, piDir, sessionsDir, allowModelNetwork: false });
  // Pin openai to the labeled account so its credential read has a failure mode
  // this test can trigger without the network: deleting the record below makes
  // every openai read throw CredentialSelectionError.
  const { session } = await runtime.createSession({ workspace: piDir, credentialLabels: { openai: "work" } });

  const healthy = await session.getModels();
  assert.ok(healthy.some((m) => m.provider === "anthropic"), "expected anthropic models while all providers are healthy");
  assert.ok(healthy.some((m) => m.provider === "openai"), "expected openai models while all providers are healthy");

  // The pinned openai account disappears (revoked on another device, pruned from
  // a hosted snapshot…). Its credential read now throws.
  await store.deleteRecord("openai", "work");

  const degraded = await session.getModels();
  assert.ok(degraded.length > 0, "a broken provider must not blank the whole connected-model list");
  assert.ok(degraded.some((m) => m.provider === "anthropic"), "healthy providers must keep listing");
  assert.ok(degraded.every((m) => m.provider !== "openai"), "the broken provider is skipped, not fabricated");

  // The full catalog (connected + unconnected providers) must also survive the
  // failed availability refresh instead of rejecting the whole picker payload.
  const all = await session.getAllModels!();
  assert.ok(all.length > 0, "getAllModels() must tolerate a failed availability refresh");
  assert.ok(all.some((m) => m.provider === "anthropic" && m.configured === true), "connected providers keep their flag");

  session.dispose();
  fs.rmSync(piDir, { recursive: true, force: true });

  console.log("pi broken-provider degrade OK (catalog survives one failing provider)");
}
