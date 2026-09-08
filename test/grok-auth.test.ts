// Unit tests for Grok credential materialization (src/runtime/grok-auth.ts).
//
// These use a real on-disk vault in a scratch dir and isolate GROK_HOME so they
// never touch a real ~/.grok. Refresh is exercised via a stubbed fetch.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCredentialVault } from "../src/runtime/credential-store.js";
import { ensureGrokAuth, grokAuthEntryKey, resolveGrokHome, GROK_OIDC_ISSUER } from "../src/runtime/grok-auth.js";
import { grokAuthFile, grokCredentialPreflight, GROK_NO_CREDENTIAL_MESSAGE } from "../src/runtime/grok-preflight.js";

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${(error as Error).stack ?? (error as Error).message}`);
  }
}

// The real xAI access token is a JWT whose `sub` claim is the user id the Grok
// CLI records as `user_id`. Mint a matching fake so the materializer can recover
// it exactly as it does in production.
const XAI_SUB = "user-abc-123";
function fakeJwt(claims: Record<string, unknown>): string {
  const seg = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${seg({ alg: "none", typ: "JWT" })}.${seg(claims)}.sig`;
}
const XAI_ACCESS_TOKEN = fakeJwt({ sub: XAI_SUB, iss: GROK_OIDC_ISSUER });

function freshVault(withXai = true): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-auth-vault-"));
  const vault: Record<string, unknown> = {};
  if (withXai) {
    vault.xai = {
      type: "oauth",
      access: XAI_ACCESS_TOKEN,
      refresh: "xai-refresh-token",
      expires: Date.now() + 3_600_000,
    };
  }
  fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify(vault));
  return dir;
}

function freshGrokHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-auth-home-"));
  process.env.GROK_HOME = dir;
  return dir;
}

function clearApiKeyEnv() {
  delete process.env.XAI_API_KEY;
  delete process.env.GROK_API_KEY;
}

await check("mints auth.json from the vault in Grok's OIDC shape", async () => {
  clearApiKeyEnv();
  const vaultDir = freshVault();
  const home = freshGrokHome();

  const result = await ensureGrokAuth(vaultDir);
  assert.equal(result, home, "returns the resolved GROK_HOME");

  const auth = JSON.parse(fs.readFileSync(path.join(home, "auth.json"), "utf8"));
  const entryKey = grokAuthEntryKey();
  assert.ok(auth[entryKey], `auth.json has entry under ${entryKey}`);
  const entry = auth[entryKey];
  assert.equal(entry.key, XAI_ACCESS_TOKEN);
  assert.equal(entry.user_id, XAI_SUB, "records user_id from the access token's sub claim");
  assert.equal(entry.refresh_token, "xai-refresh-token");
  assert.equal(entry.auth_mode, "oidc");
  assert.equal(entry.oidc_issuer, GROK_OIDC_ISSUER);
  assert.ok(typeof entry.oidc_client_id === "string" && entry.oidc_client_id.length > 0);
  assert.ok(typeof entry.expires_at === "string" && entry.expires_at.length > 0);
  assert.ok(typeof entry.create_time === "string" && entry.create_time.length > 0);
});

await check("is a no-op (no overwrite) when a parseable entry for our scope exists", async () => {
  clearApiKeyEnv();
  const vaultDir = freshVault();
  const home = freshGrokHome();
  const entryKey = grokAuthEntryKey();
  // A healthy entry (has a user_id) is Grok's to own and refresh.
  const existing = { [entryKey]: { key: "keep-me", user_id: "native-user", auth_mode: "oidc" } };
  fs.writeFileSync(path.join(home, "auth.json"), JSON.stringify(existing));

  const result = await ensureGrokAuth(vaultDir);
  assert.equal(result, home, "returns GROK_HOME without minting");
  const auth = JSON.parse(fs.readFileSync(path.join(home, "auth.json"), "utf8"));
  assert.deepEqual(auth, existing, "a healthy auth.json is left untouched");
});

await check("heals a legacy entry that is missing user_id (unparseable by the current CLI)", async () => {
  clearApiKeyEnv();
  const vaultDir = freshVault();
  const home = freshGrokHome();
  const entryKey = grokAuthEntryKey();
  // An entry written by an older Bivy: no `user_id`, so the current Grok CLI
  // rejects it. Also carry an unrelated scope that must be preserved.
  const legacy = {
    [entryKey]: { key: "stale-access", auth_mode: "oidc", refresh_token: "stale-rt" },
    "https://auth.x.ai::other-client": { key: "keep-me", user_id: "other-user", auth_mode: "oidc" },
  };
  fs.writeFileSync(path.join(home, "auth.json"), JSON.stringify(legacy));

  const result = await ensureGrokAuth(vaultDir);
  assert.equal(result, home);
  const auth = JSON.parse(fs.readFileSync(path.join(home, "auth.json"), "utf8"));
  assert.equal(auth[entryKey].key, XAI_ACCESS_TOKEN, "our scope is re-minted from the vault");
  assert.equal(auth[entryKey].user_id, XAI_SUB, "healed entry now carries user_id");
  assert.deepEqual(auth["https://auth.x.ai::other-client"], legacy["https://auth.x.ai::other-client"], "other scopes are preserved");
});

await check("returns undefined when the vault has no xai credential", async () => {
  clearApiKeyEnv();
  const vaultDir = freshVault(false);
  freshGrokHome();

  const result = await ensureGrokAuth(vaultDir);
  assert.equal(result, undefined);
});

await check("returns undefined when an API key is already ambient (no auth.json needed)", async () => {
  process.env.XAI_API_KEY = "xai-ambient-key";
  const vaultDir = freshVault();
  const home = freshGrokHome();

  const result = await ensureGrokAuth(vaultDir);
  assert.equal(result, undefined);
  assert.ok(!fs.existsSync(path.join(home, "auth.json")), "no auth.json when API key is present");
  delete process.env.XAI_API_KEY;
});

await check("resolveGrokHome respects GROK_HOME", () => {
  process.env.GROK_HOME = "/tmp/custom-grok-home";
  assert.equal(resolveGrokHome(), "/tmp/custom-grok-home");
  delete process.env.GROK_HOME;
});

await check("preflight passes when XAI_API_KEY is set", () => {
  assert.equal(grokCredentialPreflight({ XAI_API_KEY: "xai-key" }), undefined);
});

await check("preflight passes when GROK_API_KEY is set", () => {
  assert.equal(grokCredentialPreflight({ GROK_API_KEY: "g-key" }), undefined);
});

await check("preflight passes when auth.json exists under GROK_HOME", () => {
  assert.equal(
    grokCredentialPreflight(
      { GROK_HOME: "/tmp/grok-home" },
      { fileExists: (p) => p === path.join("/tmp/grok-home", "auth.json") },
    ),
    undefined,
  );
});

await check("preflight fails with the actionable message when nothing is present", () => {
  const msg = grokCredentialPreflight({}, { fileExists: () => false, home: "/tmp/no-such-home" });
  assert.equal(msg, GROK_NO_CREDENTIAL_MESSAGE);
});

await check("grokAuthFile defaults to ~/.grok/auth.json", () => {
  const prev = process.env.GROK_HOME;
  delete process.env.GROK_HOME;
  assert.equal(grokAuthFile({ home: "/Users/me" }), path.join("/Users/me", ".grok", "auth.json"));
  if (prev !== undefined) process.env.GROK_HOME = prev;
});

if (failures > 0) {
  console.error(`grok-auth: ${failures} test(s) failed`);
  process.exit(1);
}
console.log("grok-auth: all tests passed");
