import assert from "node:assert/strict";
import path from "node:path";
import {
  anthropicCredentialPreflight,
  hasAnthropicCredential,
  claudeCredentialFiles,
  describeAnthropicError,
  isAnthropicAuthError,
  probeAnthropicAccess,
  ANTHROPIC_NO_CREDENTIAL_MESSAGE,
  ANTHROPIC_AUTH_HINT,
} from "../src/runtime/anthropic-preflight.js";

// The Claude Code SDK authenticates via ANTHROPIC_API_KEY, a Claude subscription
// token (CLAUDE_CODE_OAUTH_TOKEN), or the `claude` CLI's on-disk login. The
// preflight must let a turn run when any exists and block with sign-in guidance
// when none do — instead of the opaque upstream "unexpected status 401 …".

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

const linuxNoFiles = { fileExists: () => false, home: "/home/tester", platform: "linux" as const };

check("passes when ANTHROPIC_API_KEY is present", () => {
  assert.equal(anthropicCredentialPreflight({ ANTHROPIC_API_KEY: "sk-ant-abc" }, linuxNoFiles), undefined);
});

check("passes when CLAUDE_CODE_OAUTH_TOKEN is present", () => {
  assert.equal(anthropicCredentialPreflight({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-xyz" }, linuxNoFiles), undefined);
});

check("passes when the claude CLI has a login file on disk", () => {
  const [primary] = claudeCredentialFiles({ home: "/home/tester" });
  assert.equal(primary, path.join("/home/tester", ".claude", ".credentials.json"));
  const exists = (p: string) => p === primary;
  assert.equal(anthropicCredentialPreflight({}, { fileExists: exists, home: "/home/tester", platform: "linux" }), undefined);
});

check("CLAUDE_CONFIG_DIR is searched for the login file", () => {
  const files = claudeCredentialFiles({ home: "/home/tester", configDir: "/cfg/claude" });
  assert.ok(files.includes(path.join("/cfg/claude", ".credentials.json")));
  const exists = (p: string) => p === path.join("/cfg/claude", ".credentials.json");
  assert.equal(hasAnthropicCredential({}, { fileExists: exists, home: "/home/tester", configDir: "/cfg/claude", platform: "linux" }), true);
});

check("blocks with actionable guidance when nothing is configured (linux)", () => {
  const msg = anthropicCredentialPreflight({}, linuxNoFiles);
  assert.equal(msg, ANTHROPIC_NO_CREDENTIAL_MESSAGE);
  assert.ok(/\/login/.test(msg!), "points at `/login`");
  assert.ok(/Models & providers/.test(msg!), "points at Models & providers");
});

check("never false-blocks on macOS (login lives in the Keychain, no file)", () => {
  assert.equal(hasAnthropicCredential({}, { fileExists: () => false, home: "/Users/tester", platform: "darwin" }), true);
  assert.equal(anthropicCredentialPreflight({}, { fileExists: () => false, home: "/Users/tester", platform: "darwin" }), undefined);
});

check("blank/whitespace credentials do not count", () => {
  assert.equal(anthropicCredentialPreflight({ ANTHROPIC_API_KEY: "  ", CLAUDE_CODE_OAUTH_TOKEN: "" }, linuxNoFiles), ANTHROPIC_NO_CREDENTIAL_MESSAGE);
});

check("isAnthropicAuthError matches real 401 phrasings", () => {
  assert.ok(isAnthropicAuthError("unexpected status 401 Unauthorized: Missing bearer or basic authentication in header"));
  assert.ok(isAnthropicAuthError("invalid x-api-key"));
  assert.ok(isAnthropicAuthError("authentication_error: OAuth token has expired"));
  assert.ok(!isAnthropicAuthError("ECONNREFUSED 127.0.0.1:443"));
  assert.ok(!isAnthropicAuthError("rate_limit_error: 429 Too Many Requests"));
});

check("describeAnthropicError appends guidance to auth failures only", () => {
  const authed = describeAnthropicError("unexpected status 401 Unauthorized: Missing bearer");
  assert.ok(authed.includes("401"), "keeps the original error");
  assert.ok(authed.includes(ANTHROPIC_AUTH_HINT), "appends the sign-in hint");
  const other = describeAnthropicError("connection reset");
  assert.equal(other, "connection reset", "non-auth errors pass through untouched");
});

async function acheck(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${(error as Error).stack ?? (error as Error).message}`);
  }
}

const okFetch = (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as typeof fetch;
const unauthorizedFetch = (async () => new Response("bad key", { status: 401 })) as typeof fetch;
const rateLimitedFetch = (async () => new Response("slow down", { status: 429 })) as typeof fetch;
const downFetch = (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch;

await acheck("probe: a valid API key reports authoritative access", async () => {
  const r = await probeAnthropicAccess("sk-ant-valid", { fetch: okFetch });
  assert.deepEqual({ probed: r.probed, ok: r.ok }, { probed: true, ok: true });
});

await acheck("probe: a 401 is an authoritative rejection", async () => {
  const r = await probeAnthropicAccess("sk-ant-bad", { fetch: unauthorizedFetch });
  assert.equal(r.probed, true);
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
});

await acheck("probe: rate-limit/5xx is inconclusive, never a false rejection", async () => {
  const r = await probeAnthropicAccess("sk-ant-valid", { fetch: rateLimitedFetch });
  assert.equal(r.probed, false, "429 must not be reported as a definitive result");
  assert.equal(r.ok, true, "an inconclusive probe must not fail readiness");
});

await acheck("probe: a network error is inconclusive, not a rejection", async () => {
  const r = await probeAnthropicAccess("sk-ant-valid", { fetch: downFetch });
  assert.equal(r.probed, false);
  assert.equal(r.ok, true);
});

await acheck("probe: non-API-key credentials (OAuth/CLI) are not probed", async () => {
  let called = false;
  const spy = (async () => { called = true; return new Response("", { status: 200 }); }) as typeof fetch;
  const r = await probeAnthropicAccess("oauth-subscription-token", { fetch: spy });
  assert.equal(called, false, "must not send a request for a non-sk- credential");
  assert.deepEqual({ probed: r.probed, ok: r.ok }, { probed: false, ok: true });
  const empty = await probeAnthropicAccess(undefined, { fetch: spy });
  assert.equal(empty.probed, false);
});

if (failures > 0) {
  console.error(`\n${failures} anthropic-preflight test(s) failed`);
  process.exit(1);
}
console.log("\nall anthropic-preflight tests passed");
