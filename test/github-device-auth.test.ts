import assert from "node:assert/strict";
import {
  interpretTokenResponse,
  requestDeviceCode,
  deviceFlowClientId,
  REPO_CONNECT_SCOPE,
} from "../src/github-device-auth.js";

/**
 * Staged repo-scope device flow (C3). The token poll is a small state machine;
 * test it directly, and the device-code request against a fetch stub.
 */

let failures = 0;
const tests: Array<{ name: string; fn: () => Promise<void> | void }> = [];
function test(name: string, fn: () => Promise<void> | void) {
  tests.push({ name, fn });
}

test("scope is the repo scope (not minimal login scope)", () => {
  assert.equal(REPO_CONNECT_SCOPE, "repo");
});

test("clientId comes from env, undefined when unset", () => {
  assert.equal(deviceFlowClientId({ BIVY_GITHUB_OAUTH_CLIENT_ID: " abc " }), "abc");
  assert.equal(deviceFlowClientId({}), undefined);
});

test("interpretTokenResponse: maps GitHub's poll states", () => {
  assert.deepEqual(interpretTokenResponse({ access_token: "ght_x" }), { status: "ok", token: "ght_x" });
  assert.deepEqual(interpretTokenResponse({ error: "authorization_pending" }), { status: "pending" });
  assert.deepEqual(interpretTokenResponse({ error: "slow_down", interval: 10 }), { status: "slow_down", intervalSec: 10 });
  assert.deepEqual(interpretTokenResponse({ error: "access_denied" }), { status: "denied" });
  assert.deepEqual(interpretTokenResponse({ error: "expired_token" }), { status: "expired" });
  assert.equal(interpretTokenResponse({ error: "weird", error_description: "boom" }).status, "error");
});

test("requestDeviceCode: posts client_id + scope, normalises the response", async () => {
  const calls: Array<{ url: string; body: any }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: { body?: string }) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
    return {
      ok: true,
      json: async () => ({ device_code: "dc", user_code: "WXYZ-1234", verification_uri: "https://github.com/login/device", interval: 5, expires_in: 900 }),
    } as Response;
  }) as typeof fetch;
  try {
    const device = await requestDeviceCode("client-123");
    assert.equal(device.deviceCode, "dc");
    assert.equal(device.userCode, "WXYZ-1234");
    assert.equal(device.intervalSec, 5);
    assert.equal(calls[0].url, "https://github.com/login/device/code");
    assert.equal(calls[0].body.client_id, "client-123");
    assert.equal(calls[0].body.scope, "repo");
  } finally {
    globalThis.fetch = original;
  }
});

for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${(error as Error).message}`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log("\ngithub-device-auth: all tests passed");
