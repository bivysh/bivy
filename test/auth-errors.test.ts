import assert from "node:assert/strict";
import { isModelAuthError, authProviderForSession, classifyModelAuthError } from "../src/runtime/auth-errors.js";

// A runtime that lacks a usable model credential — or holds an expired/invalid
// one — fails its first upstream request with a 401. The daemon classifies that
// surfaced error with isModelAuthError and resolves the provider to (re)sign-in
// for with authProviderForSession, so the client can pop the "Sign in to your
// model" sheet instead of leaving a bare error bubble.

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${(error as Error).stack ?? (error as Error).message}`);
  }
}

// The exact string the reported Codex app-server 401 produced.
const CODEX_WEBSOCKET_401 =
  "codex_api::endpoint::responses_websocket failed to connect to websocket: HTTP error: 401 Unauthorized, url: wss://api.openai.com/v1/responses";

check("matches the Codex app-server websocket 401", () => {
  assert.equal(isModelAuthError(CODEX_WEBSOCKET_401), true);
});

check("matches a missing-bearer 401", () => {
  assert.equal(isModelAuthError("unexpected status 401 Unauthorized: Missing bearer or basic authentication in header"), true);
});

check("matches a generic API 401", () => {
  assert.equal(isModelAuthError("API Error: 401 {\"error\":{\"message\":\"invalid api key\"}}"), true);
});

check("matches an invalid x-api-key error", () => {
  assert.equal(isModelAuthError("invalid x-api-key"), true);
});

check("does not match benign prose or other failures", () => {
  assert.equal(isModelAuthError("Tool exited with code 1: file not found"), false);
  assert.equal(isModelAuthError("Rate limited (429), please retry"), false);
  assert.equal(isModelAuthError(""), false);
});

check("does not match a websocket failure that is not a 401/403", () => {
  assert.equal(
    isModelAuthError("failed to connect to websocket: HTTP error: 500 Internal Server Error"),
    false,
  );
});

check("codex runtimes resolve to the openai-codex subscription provider", () => {
  assert.equal(authProviderForSession("codex"), "openai-codex");
  assert.equal(authProviderForSession("codex-approvals"), "openai-codex");
  // Runtime id wins over the model provider for codex (the model may report
  // "openai-codex" or nothing at all).
  assert.equal(authProviderForSession("codex-approvals", undefined), "openai-codex");
});

check("auth failures become a safe structured wire error", () => {
  assert.deepEqual(
    classifyModelAuthError(`${CODEX_WEBSOCKET_401}\n/home/user/node_modules/private.js:10`, "codex"),
    { kind: "model_auth", provider: "openai-codex" },
  );
  assert.equal(classifyModelAuthError("file not found", "pi", "anthropic"), null);
});

check("a known model provider maps to itself", () => {
  assert.equal(authProviderForSession("pi", "anthropic"), "anthropic");
  assert.equal(authProviderForSession("pi", "openai"), "openai");
  assert.equal(authProviderForSession("opencode", "xai"), "xai");
});

check("an unknown/absent provider yields undefined (no sheet raised)", () => {
  assert.equal(authProviderForSession("pi", undefined), undefined);
  assert.equal(authProviderForSession("pi", "some-unlisted-provider"), undefined);
});

if (failures > 0) {
  console.error(`\n${failures} auth-errors test(s) failed`);
  process.exit(1);
}
console.log("\nall auth-errors tests passed");
