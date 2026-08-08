// Tests for capturing credentials FROM an agent's own store back into Bivy's
// vault (src/runtime/credential-ingest.ts) — the reverse-direction unification.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCredentialVault } from "../src/runtime/credential-store.js";
import { claudeAuthToCredential, codexAuthToCredential, grokAuthToCredential, ingestAgentCredentials } from "../src/runtime/credential-ingest.js";
import { grokAuthEntryKey } from "../src/runtime/grok-auth.js";

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

/** A JWT whose `exp` claim is `seconds` from the epoch. */
function jwtWithExp(expSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString("base64url");
  return `${header}.${payload}.sig`;
}

await check("maps a Codex ChatGPT auth.json to an oauth credential with JWT expiry + account id", async () => {
  const expSeconds = Math.floor(Date.now() / 1000) + 3600;
  const mapped = codexAuthToCredential({
    tokens: { access_token: jwtWithExp(expSeconds), refresh_token: "rt", account_id: "acct-9" },
  });
  assert.equal(mapped?.providerId, "openai-codex");
  assert.equal(mapped?.credential.type, "oauth");
  assert.equal((mapped?.credential as { refresh?: string }).refresh, "rt");
  assert.equal((mapped?.credential as { accountId?: string }).accountId, "acct-9");
  assert.equal((mapped?.credential as { expires?: number }).expires, expSeconds * 1000, "expiry taken from the JWT exp claim");
});

await check("maps a Codex api-key auth.json to an api_key credential for openai", async () => {
  const mapped = codexAuthToCredential({ OPENAI_API_KEY: "sk-codex" });
  assert.equal(mapped?.providerId, "openai");
  assert.deepEqual(mapped?.credential, { type: "api_key", key: "sk-codex" });
});

await check("ingestAgentCredentials('codex') folds ~/.codex/auth.json into the vault", async () => {
  const piDir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-ingest-pi-"));
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-ingest-codex-"));
  process.env.CODEX_HOME = codexHome;
  const expSeconds = Math.floor(Date.now() / 1000) + 3600;
  fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify({ tokens: { access_token: jwtWithExp(expSeconds), refresh_token: "rt-codex", account_id: "acct-1" } }));

  const imported = await ingestAgentCredentials("codex", piDir, piDir);
  assert.equal(imported, 1, "one new provider imported");
  const stored = await createCredentialVault(piDir).read("openai-codex");
  assert.equal((stored as { refresh?: string }).refresh, "rt-codex", "the Codex login is now in Bivy's vault");
});

await check("ingest is rotation-safe: a fresher agent token wins, a staler one is ignored", async () => {
  const piDir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-ingest-rot-"));
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-ingest-rot-codex-"));
  process.env.CODEX_HOME = codexHome;
  const store = createCredentialVault(piDir);
  // Bivy already holds a fresh token.
  const future = Date.now() + 10 * 60 * 1000;
  await store.modify("openai-codex", async () => ({ type: "oauth", access: "bivy-fresh", refresh: "bivy-rt", expires: future }));

  // Codex's on-disk token is OLDER — must not clobber Bivy's fresher one.
  const olderExp = Math.floor((Date.now() - 1000) / 1000);
  fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify({ tokens: { access_token: jwtWithExp(olderExp), refresh_token: "codex-old" } }));
  await ingestAgentCredentials("codex", piDir, piDir);
  assert.equal((await store.read("openai-codex") as { access?: string }).access, "bivy-fresh", "staler agent token did not overwrite the fresher vault token");
});

await check("maps a Claude .credentials.json (claudeAiOauth) to an anthropic oauth credential", async () => {
  const mapped = claudeAuthToCredential({ claudeAiOauth: { accessToken: "at", refreshToken: "rt", expiresAt: 1234 } });
  assert.equal(mapped?.providerId, "anthropic");
  assert.equal((mapped?.credential as { access?: string }).access, "at");
  assert.equal((mapped?.credential as { expires?: number }).expires, 1234, "Claude's absolute expiresAt used as-is");
});

await check("ingestAgentCredentials('claude') folds ~/.claude/.credentials.json into the vault", async () => {
  const piDir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-ingest-cl-"));
  const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-ingest-claudeconf-"));
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  fs.writeFileSync(path.join(claudeDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "c-at", refreshToken: "c-rt", expiresAt: Date.now() + 3_600_000 } }));

  const imported = await ingestAgentCredentials("claude", piDir, piDir);
  assert.equal(imported, 1, "the Claude login is imported");
  const stored = await createCredentialVault(piDir).read("anthropic");
  assert.equal((stored as { refresh?: string }).refresh, "c-rt");
  delete process.env.CLAUDE_CONFIG_DIR;
});

await check("maps a Grok OIDC auth.json entry to an xai oauth credential", async () => {
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  const mapped = grokAuthToCredential({
    [grokAuthEntryKey()]: {
      key: "g-access",
      refresh_token: "g-rt",
      auth_mode: "oidc",
      expires_at: expiresAt,
      oidc_issuer: "https://auth.x.ai",
    },
  });
  assert.equal(mapped?.providerId, "xai");
  assert.equal(mapped?.credential.type, "oauth");
  assert.equal((mapped?.credential as { access?: string }).access, "g-access");
  assert.equal((mapped?.credential as { refresh?: string }).refresh, "g-rt");
  assert.equal((mapped?.credential as { expires?: number }).expires, Date.parse(expiresAt));
});

await check("ingestAgentCredentials('grok') folds ~/.grok/auth.json into the vault", async () => {
  const piDir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-ingest-grok-"));
  const grokHome = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-ingest-grokhome-"));
  process.env.GROK_HOME = grokHome;
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  fs.writeFileSync(
    path.join(grokHome, "auth.json"),
    JSON.stringify({
      [grokAuthEntryKey()]: {
        key: "g-at",
        refresh_token: "g-rt-disk",
        auth_mode: "oidc",
        expires_at: expiresAt,
        oidc_issuer: "https://auth.x.ai",
      },
    }),
  );

  const imported = await ingestAgentCredentials("grok", piDir, piDir);
  assert.equal(imported, 1, "the Grok login is imported");
  const stored = await createCredentialVault(piDir).read("xai");
  assert.equal((stored as { refresh?: string }).refresh, "g-rt-disk");
  delete process.env.GROK_HOME;
});

await check("an unknown agent is a no-op", async () => {
  const piDir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-ingest-noop-"));
  assert.equal(await ingestAgentCredentials("goose", piDir, piDir), 0);
});

if (failures > 0) {
  console.error(`credential-ingest: ${failures} test(s) failed`);
  process.exit(1);
}
console.log("credential-ingest: all tests passed");
