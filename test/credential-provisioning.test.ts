// Tests for the unified credential provisioning seam
// (src/runtime/credential-provisioning.ts): one Bivy login projected onto any
// native agent as env vars and/or a native on-disk store, refreshed first.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCredentialVault } from "../src/runtime/credential-store.js";
import { provisionAgentEnv, provisionAgentRun, provisionPiAuthJson } from "../src/runtime/credential-provisioning.js";

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

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bivy-provision-"));
}

function stubFetch(json: unknown): () => number {
  let calls = 0;
  (globalThis as { fetch: unknown }).fetch = async () => {
    calls += 1;
    return { ok: true, status: 200, text: async () => JSON.stringify(json) } as unknown as Response;
  };
  return () => calls;
}

await check("provisionAgentEnv projects api keys and a refreshed OAuth token as env vars", async () => {
  const dir = tmpDir();
  const store = createCredentialVault(dir);
  await store.modify("openai", async () => ({ type: "api_key", key: "sk-openai" }));
  // An already-expired Claude subscription token — provisioning must refresh it.
  await store.modify("anthropic", async () => ({ type: "oauth", access: "stale", refresh: "rt", expires: Date.now() - 1000 }));
  const calls = stubFetch({ access_token: "fresh-oauth", refresh_token: "rt2", expires_in: 3600 });

  const env = await provisionAgentEnv(dir);
  assert.equal(env.OPENAI_API_KEY, "sk-openai", "api key projected to its env var");
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "fresh-oauth", "expired subscription token refreshed before projection");
  assert.ok(calls() >= 1, "a refresh exchange happened");
  const stored = await store.read("anthropic");
  assert.equal((stored as { access?: string }).access, "fresh-oauth", "the refreshed token is persisted back to the vault");
});

await check("provisionPiAuthJson materializes Pi's plaintext auth.json in Pi's own dir, not the shared vault dir", async () => {
  const credsDir = tmpDir();
  const piDir = path.join(credsDir, "pi");
  const store = createCredentialVault(credsDir);
  await store.modify("openai", async () => ({ type: "api_key", key: "sk-1" }));
  await provisionPiAuthJson(credsDir, piDir);

  const authPath = path.join(piDir, "auth.json");
  assert.ok(fs.existsSync(authPath), "auth.json is written to Pi's dir");
  assert.ok(!fs.existsSync(path.join(credsDir, "auth.json")), "the shared vault dir gets no plaintext projection");
  const onDisk = JSON.parse(fs.readFileSync(authPath, "utf8"));
  assert.deepEqual(onDisk.openai, { type: "api_key", key: "sk-1" }, "vault contents projected to Pi's format");
});

await check("provisionAgentRun('pi') returns env AND materializes Pi's native store in Pi's dir", async () => {
  const credsDir = tmpDir();
  const piDir = path.join(credsDir, "pi");
  const store = createCredentialVault(credsDir);
  await store.modify("groq", async () => ({ type: "api_key", key: "gsk-1" }));
  const env = await provisionAgentRun(credsDir, piDir, "pi");
  assert.equal(env.GROQ_API_KEY, "gsk-1", "env projection present");
  assert.ok(fs.existsSync(path.join(piDir, "auth.json")), "pi native store materialized in Pi's dir");
});

await check("provisionAgentRun for a plain agent projects env without a native store", async () => {
  const credsDir = tmpDir();
  const piDir = path.join(credsDir, "pi");
  const store = createCredentialVault(credsDir);
  await store.modify("openai", async () => ({ type: "api_key", key: "sk-x" }));
  const env = await provisionAgentRun(credsDir, piDir, "goose");
  assert.equal(env.OPENAI_API_KEY, "sk-x");
  assert.ok(!fs.existsSync(path.join(piDir, "auth.json")), "no native store for an env-only agent");
});

if (failures > 0) {
  console.error(`credential-provisioning: ${failures} test(s) failed`);
  process.exit(1);
}
console.log("credential-provisioning: all tests passed");
