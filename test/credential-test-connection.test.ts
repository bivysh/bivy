// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Unit coverage for `testCredential` (src/credentials/api.ts) — the "Test
// connection" probe behind Settings' redacted readiness rows. Exercises the
// oauth, api_key, and unsupported/reference paths with a fake fetch and a fake
// OAuthRefresher (never a real network call), and asserts the result — and the
// on-disk verification record it persists — never carries key/token material.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { testCredential } from "../src/credentials/api.js";
import { createCredentialVault } from "../src/credentials/store.js";
import type { OAuthRefresher } from "../src/credentials/ports.js";

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

function freshDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bivy-cred-test-conn-"));
}

const noRefresh: OAuthRefresher = { refresh: async () => undefined };

await test("api_key: a 200 response is ok, and no secret reaches the result or the persisted record", async () => {
  const dir = freshDir();
  const vault = createCredentialVault(dir);
  await vault.putRecord({
    provider: "anthropic",
    label: "default",
    origin: "bivy",
    sync: "account",
    source: { kind: "stored", cred: { type: "api_key", key: "sk-fixture-super-secret-value" } },
  });

  let seenHeaders: Record<string, string> | undefined;
  const fakeFetch = (async (url: string, init?: { headers?: Record<string, string> }) => {
    seenHeaders = init?.headers;
    return { ok: true, status: 200 } as Response;
  }) as typeof fetch;

  const result = await testCredential(dir, "anthropic", "default", noRefresh, fakeFetch);
  assert.equal(result.ok, true);
  assert.equal(result.reason, undefined);
  assert.equal(seenHeaders?.["x-api-key"], "sk-fixture-super-secret-value", "the secret DOES go to the provider's own API — that's the point of the probe");
  assert.ok(!JSON.stringify(result).includes("sk-fixture-super-secret-value"), "the secret never appears in the returned CredentialVerification");

  const persisted = await vault.readVerification("anthropic", "default");
  assert.deepEqual(persisted, { ok: true, at: result.at });
  assert.ok(!JSON.stringify(persisted).includes("sk-fixture-super-secret-value"), "the secret never appears in the persisted verification record");
});

await test("api_key: 401/403 is reported as unauthorized, not a generic failure", async () => {
  const dir = freshDir();
  await createCredentialVault(dir).putRecord({
    provider: "openai",
    label: "default",
    origin: "bivy",
    sync: "account",
    source: { kind: "stored", cred: { type: "api_key", key: "sk-bad" } },
  });
  const fakeFetch = (async () => ({ ok: false, status: 401 }) as Response) as typeof fetch;
  const result = await testCredential(dir, "openai", "default", noRefresh, fakeFetch);
  assert.deepEqual(result, { ok: false, at: result.at, reason: "unauthorized" });
});

await test("api_key: a thrown/aborted fetch is reported as network_error, never the raw error string", async () => {
  const dir = freshDir();
  await createCredentialVault(dir).putRecord({
    provider: "openai",
    label: "default",
    origin: "bivy",
    sync: "account",
    source: { kind: "stored", cred: { type: "api_key", key: "sk-flaky" } },
  });
  const fakeFetch = (async () => {
    throw new Error("getaddrinfo ENOTFOUND api.openai.com — details irrelevant to the caller");
  }) as unknown as typeof fetch;
  const result = await testCredential(dir, "openai", "default", noRefresh, fakeFetch);
  assert.deepEqual(result, { ok: false, at: result.at, reason: "network_error" });
});

await test("oauth: a live access token is probed directly, without a refresh call", async () => {
  const dir = freshDir();
  let refreshCalls = 0;
  const oauth: OAuthRefresher = { refresh: async () => { refreshCalls += 1; return "should-not-be-used"; } };
  await createCredentialVault(dir).putRecord({
    provider: "anthropic",
    label: "default",
    origin: "bivy",
    sync: "account",
    source: { kind: "stored", cred: { type: "oauth", access: "live-access-token", refresh: "r", expires: Date.now() + 60 * 60_000 } },
  });
  let seenAuth: string | undefined;
  const fakeFetch = (async (_url: string, init?: { headers?: Record<string, string> }) => {
    seenAuth = init?.headers?.["x-api-key"];
    return { ok: true, status: 200 } as Response;
  }) as typeof fetch;

  const result = await testCredential(dir, "anthropic", "default", oauth, fakeFetch);
  assert.equal(result.ok, true);
  assert.equal(refreshCalls, 0, "a still-valid access token must not trigger a refresh");
  assert.equal(seenAuth, "live-access-token");
});

await test("oauth: an expired access token refreshes first, and a working new token counts as ok", async () => {
  const dir = freshDir();
  const oauth: OAuthRefresher = { refresh: async () => "refreshed-access-token" };
  await createCredentialVault(dir).putRecord({
    provider: "anthropic",
    label: "default",
    origin: "bivy",
    sync: "account",
    source: { kind: "stored", cred: { type: "oauth", access: "stale", refresh: "r", expires: Date.now() - 1000 } },
  });
  let seenAuth: string | undefined;
  const fakeFetch = (async (_url: string, init?: { headers?: Record<string, string> }) => {
    seenAuth = init?.headers?.["x-api-key"];
    return { ok: true, status: 200 } as Response;
  }) as typeof fetch;

  const result = await testCredential(dir, "anthropic", "default", oauth, fakeFetch);
  assert.equal(result.ok, true);
  assert.equal(seenAuth, "refreshed-access-token");
});

await test("oauth: a failed refresh is reported as refresh_failed, and the provider is never pinged", async () => {
  const dir = freshDir();
  let pinged = false;
  await createCredentialVault(dir).putRecord({
    provider: "anthropic",
    label: "default",
    origin: "bivy",
    sync: "account",
    source: { kind: "stored", cred: { type: "oauth", access: "stale", refresh: "r", expires: Date.now() - 1000 } },
  });
  const fakeFetch = (async () => { pinged = true; return { ok: true, status: 200 } as Response; }) as typeof fetch;

  const result = await testCredential(dir, "anthropic", "default", noRefresh, fakeFetch);
  assert.deepEqual(result, { ok: false, at: result.at, reason: "refresh_failed" });
  assert.equal(pinged, false, "no live/expired token means no provider call should be made");
});

await test("reference credential (op://…): not_supported, resolving it is out of scope for this probe", async () => {
  const dir = freshDir();
  await createCredentialVault(dir).putRecord({
    provider: "anthropic",
    label: "default",
    origin: "bivy",
    sync: "account",
    source: { kind: "reference", ref: "op://vault/item/field", backend: "1password" },
  });
  const result = await testCredential(dir, "anthropic", "default", noRefresh, (async () => {
    throw new Error("must not be called for a reference credential");
  }) as unknown as typeof fetch);
  assert.deepEqual(result, { ok: false, at: result.at, reason: "not_supported" });
});

await test("a provider outside PROVIDER_PING is honestly not_supported, never guessed at", async () => {
  const dir = freshDir();
  await createCredentialVault(dir).putRecord({
    provider: "some-custom-endpoint",
    label: "default",
    origin: "bivy",
    sync: "node",
    source: { kind: "stored", cred: { type: "api_key", key: "k" } },
  });
  const result = await testCredential(dir, "some-custom-endpoint", "default", noRefresh, (async () => {
    throw new Error("must not be called for an untestable provider");
  }) as unknown as typeof fetch);
  assert.deepEqual(result, { ok: false, at: result.at, reason: "not_supported" });
});

await test("no stored credential for the provider/label: not_found", async () => {
  const dir = freshDir();
  const result = await testCredential(dir, "anthropic", "default", noRefresh, (async () => {
    throw new Error("must not be called with nothing stored");
  }) as unknown as typeof fetch);
  assert.deepEqual(result, { ok: false, at: result.at, reason: "not_found" });
});

console.log(`\n${passed} passed`);
