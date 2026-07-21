import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PiRuntime } from "../src/runtime/pi.js";
import { createCredentialVault } from "../src/runtime/credential-store.js";

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
