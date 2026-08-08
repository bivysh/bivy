import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCredentialStore, buildAgentCredentialEnv } from "../src/runtime/credentials.js";
import { exportProviderAuth, importProviderAuth } from "../src/runtime/pi-auth.js";

// A shared node sign-in should reach *any* selected agent, not just the Pi agent
// that owns auth.json. buildAgentCredentialEnv is the seam that maps the vault's
// contents onto the conventional provider env vars an arbitrary agent reads.

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-cred-vault-"));
fs.writeFileSync(
  path.join(dir, "auth.json"),
  JSON.stringify({
    openai: { type: "api_key", key: "sk-openai-123" },
    anthropic: { type: "oauth", access: "oauth-anthropic-xyz", refresh: "r", expires: Date.now() + 3_600_000 },
    groq: { type: "api_key", key: "gsk-groq-789" },
  }),
  { mode: 0o600 },
);

const store = createCredentialStore(dir);

assert.ok(store.listConfigured, "credential vault exposes listConfigured");
const configured = (await store.listConfigured!()).sort();
assert.deepEqual(configured, ["anthropic", "groq", "openai"], "vault lists every configured provider");

const env = await buildAgentCredentialEnv(store);
assert.equal(env.OPENAI_API_KEY, "sk-openai-123", "api-key provider maps to its conventional env var");
assert.equal(env.GROQ_API_KEY, "gsk-groq-789", "second api-key provider is injected too");
assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "oauth-anthropic-xyz", "Anthropic OAuth maps to the Claude Code OAuth var");
assert.equal(env.ANTHROPIC_API_KEY, undefined, "OAuth subscription is not exposed as an API key");

// xAI API keys are projected as both XAI_API_KEY (official CLI) and GROK_API_KEY
// (vibe-kit / forks), so either binary works off one Bivy login.
const xaiDir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-cred-xai-"));
fs.writeFileSync(
  path.join(xaiDir, "auth.json"),
  JSON.stringify({ xai: { type: "api_key", key: "xai-key-abc" } }),
  { mode: 0o600 },
);
const xaiEnv = await buildAgentCredentialEnv(createCredentialStore(xaiDir));
assert.equal(xaiEnv.XAI_API_KEY, "xai-key-abc", "xAI api key maps to XAI_API_KEY");
assert.equal(xaiEnv.GROK_API_KEY, "xai-key-abc", "xAI api key is also projected as GROK_API_KEY");

// A non-Anthropic OAuth *subscription* (e.g. the ChatGPT/Codex login) can't be
// handed to an external agent as a plain API key, so it must not be emitted.
const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-cred-codex-"));
fs.writeFileSync(
  path.join(codexDir, "auth.json"),
  JSON.stringify({ "openai-codex": { type: "oauth", access: "codex-access", refresh: "r", expires: Date.now() + 3_600_000 } }),
  { mode: 0o600 },
);
const codexEnv = await buildAgentCredentialEnv(createCredentialStore(codexDir));
assert.equal(codexEnv.OPENAI_API_KEY, undefined, "Codex subscription is not emitted as an OpenAI API key");
assert.equal(codexEnv.OPENAI_CODEX_API_KEY, undefined, "Codex subscription is not emitted under a made-up var");

// An empty vault yields no env (agent falls back to its own auth) and never throws.
const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-cred-empty-"));
const emptyEnv = await buildAgentCredentialEnv(createCredentialStore(emptyDir));
assert.deepEqual(emptyEnv, {}, "no configured providers → no injected env");

// importProviderAuth must never drop or stale a fresh local login: a lagging
// account snapshot that omits a provider (or carries an older OAuth token) must
// not delete/downgrade what the user just signed into on this node.
const nodeDir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-cred-sync-"));
fs.writeFileSync(
  path.join(nodeDir, "auth.json"),
  JSON.stringify({
    // A login the user just completed on this node, not yet in the vault.
    "openai-codex": { type: "oauth", access: "fresh-local", refresh: "r2", expires: 5_000 },
    anthropic: { type: "oauth", access: "local-refreshed", refresh: "r3", expires: 9_000 },
  }),
  { mode: 0o600 },
);
// Snapshot from the control plane: missing openai-codex entirely, and an older
// anthropic token than the one this node already refreshed to.
await importProviderAuth(nodeDir, {
  anthropic: { type: "oauth", access: "stale-remote", refresh: "r0", expires: 1_000 },
  openrouter: { type: "api_key", key: "or-key" },
});
const after = (await exportProviderAuth(nodeDir)) as Record<string, any>;
assert.ok(after["openai-codex"], "a fresh local login absent from the snapshot is preserved");
assert.equal(after["openai-codex"].access, "fresh-local", "the fresh local login is not overwritten");
assert.equal(after.anthropic.access, "local-refreshed", "a locally fresher OAuth token wins over a staler snapshot");
assert.equal(after.openrouter.key, "or-key", "genuinely new providers from the snapshot are still imported");

fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(codexDir, { recursive: true, force: true });
fs.rmSync(xaiDir, { recursive: true, force: true });
fs.rmSync(emptyDir, { recursive: true, force: true });
fs.rmSync(nodeDir, { recursive: true, force: true });

console.log("credential-vault: all tests passed");
