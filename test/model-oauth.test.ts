// Unit tests for Bivy's native model-provider OAuth engine
// (src/runtime/oauth/model-oauth.ts). These stub `fetch`, so they exercise the
// token-exchange / refresh / device-poll logic without a network call or a live
// provider — the mockable surface. The live browser callback flow is the
// documented manual gate (needs real subscription accounts).

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCredentialVault } from "../src/runtime/credential-store.js";
import {
  extractAuthCode,
  escapeOAuthHtml,
  isNativeOAuthProvider,
  nativeOAuthProviderIds,
  loginModelOAuth,
  refreshModelOAuth,
  type AuthInteraction,
} from "../src/runtime/oauth/model-oauth.js";

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
  return fs.mkdtempSync(path.join(os.tmpdir(), "bivy-model-oauth-"));
}

/** A silent interaction that answers a manual_code prompt with `pasted`. */
function pasteInteraction(pasted: string): AuthInteraction {
  return { notify: () => {}, prompt: async () => pasted };
}

/** Minimal fake JWT whose OpenAI auth claim carries an account id. */
function fakeJwt(accountId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })).toString("base64url");
  return `${header}.${payload}.sig`;
}

type FetchStub = { url: string; body: string };
function stubFetch(handler: (call: FetchStub) => { ok?: boolean; status?: number; json: unknown }): () => FetchStub[] {
  const calls: FetchStub[] = [];
  (globalThis as { fetch: unknown }).fetch = async (input: unknown, init?: { body?: string }) => {
    const call = { url: String(input), body: String(init?.body ?? "") };
    calls.push(call);
    const r = handler(call);
    return { ok: r.ok ?? true, status: r.status ?? 200, text: async () => JSON.stringify(r.json) } as unknown as Response;
  };
  return () => calls;
}

await check("registry lists the natively-owned subscription providers", async () => {
  const ids = nativeOAuthProviderIds().sort();
  assert.deepEqual(ids, ["anthropic", "openai-codex", "xai"]);
  assert.ok(isNativeOAuthProvider("anthropic"));
  assert.ok(isNativeOAuthProvider("OpenAI-Codex"), "id match is case-insensitive");
  assert.ok(!isNativeOAuthProvider("github-copilot"), "copilot is not natively owned");
});

await check("extractAuthCode handles a redirect URL, code#state, and a raw code", async () => {
  assert.equal(extractAuthCode("https://localhost:1455/auth/callback?code=abc123&state=xyz"), "abc123");
  assert.equal(extractAuthCode("thecode#thestate"), "thecode");
  assert.equal(extractAuthCode("  plaincode  "), "plaincode");
});

await check("OAuth callback HTML escapes provider-controlled text", async () => {
  assert.equal(
    escapeOAuthHtml(`<script>alert("x")</script> & 'quoted'`),
    "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;quoted&#39;",
  );
});

await check("Anthropic auth-code login (manual paste) exchanges + persists an oauth credential", async () => {
  const dir = tmpDir();
  const calls = stubFetch((call) => {
    assert.equal(call.url, "https://platform.claude.com/v1/oauth/token");
    const body = JSON.parse(call.body) as Record<string, string>;
    assert.equal(body.grant_type, "authorization_code");
    assert.equal(body.code, "acode");
    assert.ok(body.code_verifier, "sends the PKCE verifier");
    assert.equal(body.state, body.code_verifier, "Anthropic state equals the verifier");
    return { json: { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 } };
  });

  await loginModelOAuth(dir, "anthropic", pasteInteraction("acode#somestate"));
  assert.equal(calls().length, 1);
  const cred = await createCredentialVault(dir).read("anthropic");
  assert.equal(cred?.type, "oauth");
  assert.equal((cred as { access?: string }).access, "at-1");
  assert.equal((cred as { refresh?: string }).refresh, "rt-1");
});

await check("OpenAI Codex login extracts the account id from the JWT access token", async () => {
  const dir = tmpDir();
  stubFetch((call) => {
    assert.equal(call.url, "https://auth.openai.com/oauth/token");
    assert.ok(call.body.includes("grant_type=authorization_code"), "form-encoded body");
    return { json: { access_token: fakeJwt("acct-42"), refresh_token: "rt", expires_in: 3600 } };
  });
  await loginModelOAuth(dir, "openai-codex", pasteInteraction("https://localhost:1455/auth/callback?code=c&state=s"));
  const cred = await createCredentialVault(dir).read("openai-codex");
  assert.equal((cred as { accountId?: string }).accountId, "acct-42");
});

await check("xAI device-code login requests a code, polls, and persists", async () => {
  const dir = tmpDir();
  let polls = 0;
  stubFetch((call) => {
    if (call.url === "https://auth.x.ai/oauth2/device/code") {
      return { json: { device_code: "dev", user_code: "USER-CODE", verification_uri: "https://x.ai/device", interval: 0, expires_in: 300 } };
    }
    // token poll
    polls += 1;
    if (polls < 2) return { ok: false, status: 400, json: { error: "authorization_pending" } };
    return { json: { access_token: "xai-at", refresh_token: "xai-rt", expires_in: 3600 } };
  });
  let sawDeviceCode = false;
  const interaction: AuthInteraction = { notify: (e) => { if (e.type === "device_code") sawDeviceCode = true; }, prompt: async () => "" };
  await loginModelOAuth(dir, "xai", interaction);
  assert.ok(sawDeviceCode, "surfaced the device code to the user");
  assert.ok(polls >= 2, "polled through the pending state");
  const cred = await createCredentialVault(dir).read("xai");
  assert.equal((cred as { access?: string }).access, "xai-at");
});

await check("xAI device poll treats a friendly \"not yet authorized\" 400 as pending, not a fatal error", async () => {
  // xAI returns a human error_description ("User has not yet authorized") with
  // HTTP 400 for the still-pending state instead of the RFC-8628
  // `authorization_pending` code — the poll must keep waiting, not abort.
  const dir = tmpDir();
  let polls = 0;
  stubFetch((call) => {
    if (call.url === "https://auth.x.ai/oauth2/device/code") {
      return { json: { device_code: "dev", user_code: "USER-CODE", verification_uri: "https://x.ai/device", interval: 0, expires_in: 300 } };
    }
    polls += 1;
    if (polls < 3) return { ok: false, status: 400, json: { error_description: "User has not yet authorized" } };
    return { json: { access_token: "xai-at", refresh_token: "xai-rt", expires_in: 3600 } };
  });
  await loginModelOAuth(dir, "xai", { notify: () => {}, prompt: async () => "" });
  assert.ok(polls >= 3, "polled through the friendly pending responses instead of throwing");
  const cred = await createCredentialVault(dir).read("xai");
  assert.equal((cred as { access?: string }).access, "xai-at");
});

await check("refresh rotates the token, persists it, and returns the fresh access token", async () => {
  const dir = tmpDir();
  const store = createCredentialVault(dir);
  await store.modify("anthropic", async () => ({ type: "oauth", access: "old", refresh: "old-rt", expires: Date.now() - 1000 }));
  const calls = stubFetch((call) => {
    const body = JSON.parse(call.body) as Record<string, string>;
    assert.equal(body.grant_type, "refresh_token");
    assert.equal(body.refresh_token, "old-rt");
    return { json: { access_token: "new-at", refresh_token: "new-rt", expires_in: 3600 } };
  });

  const token = await refreshModelOAuth(dir, "anthropic");
  assert.equal(token, "new-at");
  assert.equal(calls().length, 1);
  const cred = await store.read("anthropic");
  assert.equal((cred as { access?: string }).access, "new-at");
  assert.equal((cred as { refresh?: string }).refresh, "new-rt", "rotated refresh token is persisted");
});

await check("xAI refresh keeps the previous refresh token when the response omits one", async () => {
  const dir = tmpDir();
  const store = createCredentialVault(dir);
  await store.modify("xai", async () => ({ type: "oauth", access: "old", refresh: "keep-me", expires: Date.now() - 1000 }));
  stubFetch(() => ({ json: { access_token: "new-at", expires_in: 3600 } })); // no refresh_token
  await refreshModelOAuth(dir, "xai");
  const cred = await store.read("xai");
  assert.equal((cred as { refresh?: string }).refresh, "keep-me", "non-rotating provider keeps its refresh token");
});

await check("concurrent refresh is single-flight — only one network exchange", async () => {
  const dir = tmpDir();
  const store = createCredentialVault(dir);
  await store.modify("anthropic", async () => ({ type: "oauth", access: "old", refresh: "rt", expires: Date.now() - 1000 }));
  let exchanges = 0;
  stubFetch(() => {
    exchanges += 1;
    return { json: { access_token: `at-${exchanges}`, refresh_token: `rt-${exchanges}`, expires_in: 3600 } };
  });
  const [a, b] = await Promise.all([refreshModelOAuth(dir, "anthropic"), refreshModelOAuth(dir, "anthropic")]);
  assert.equal(exchanges, 1, "the second caller reused the first refresh instead of exchanging again");
  assert.equal(a, b, "both callers see the same fresh token");
});

if (failures > 0) {
  console.error(`model-oauth: ${failures} test(s) failed`);
  process.exit(1);
}
console.log("model-oauth: all tests passed");
