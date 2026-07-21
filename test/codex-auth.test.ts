// Unit tests for Codex credential materialization (src/runtime/codex-auth.ts).
//
// These stub `fetch` (the OpenAI refresh grant) and use a real on-disk Pi vault
// in a scratch dir, so they exercise the mint/rotate/skip logic without a network
// call or a live Codex. CODEX_HOME is isolated to a scratch dir — never a real
// ~/.codex.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCredentialVault } from "../src/runtime/credential-store.js";
import { ensureCodexAuth, ensureCodexTrusted } from "../src/runtime/codex-auth.js";

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

function freshPiDir(withCodex = true): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-auth-pi-"));
  const vault: Record<string, unknown> = {};
  if (withCodex) {
    vault["openai-codex"] = { type: "oauth", access: "old-access", refresh: "old-refresh", expires: 1, accountId: "acct-abc" };
  }
  fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify(vault));
  return dir;
}

function freshCodexHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-auth-home-"));
  process.env.CODEX_HOME = dir;
  return dir;
}

// Stub the refresh-grant fetch. Records call count and returns a token set.
function stubFetch(response: Record<string, unknown>, ok = true): () => number {
  let calls = 0;
  (globalThis as { fetch: unknown }).fetch = async () => {
    calls += 1;
    return { ok, status: ok ? 200 : 401, json: async () => response } as unknown as Response;
  };
  return () => calls;
}

const OK_TOKENS = { id_token: "ID.TOKEN.JWT", access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 };

await check("mints auth.json from the vault and rotates the refresh token", async () => {
  const piDir = freshPiDir();
  const home = freshCodexHome();
  const calls = stubFetch(OK_TOKENS);

  const result = await ensureCodexAuth(piDir);
  assert.equal(result, home, "returns the resolved CODEX_HOME");
  assert.equal(calls(), 1, "performed exactly one refresh grant");

  const auth = JSON.parse(fs.readFileSync(path.join(home, "auth.json"), "utf8"));
  assert.equal(auth.auth_mode, "chatgpt");
  assert.equal(auth.OPENAI_API_KEY, null);
  assert.equal(auth.tokens.id_token, "ID.TOKEN.JWT");
  assert.equal(auth.tokens.access_token, "new-access");
  assert.equal(auth.tokens.refresh_token, "new-refresh");
  assert.equal(auth.tokens.account_id, "acct-abc");
  assert.ok(typeof auth.last_refresh === "string" && auth.last_refresh.length > 0);

  // Rotated refresh token persisted back to the vault.
  const stored = await createCredentialVault(piDir).read("openai-codex");
  assert.equal(stored?.refresh, "new-refresh");
  assert.equal(stored?.access, "new-access");
});

await check("is a no-op (no grant) when an auth.json already exists", async () => {
  const piDir = freshPiDir();
  const home = freshCodexHome();
  fs.writeFileSync(path.join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: {} }));
  const calls = stubFetch(OK_TOKENS);

  const result = await ensureCodexAuth(piDir);
  assert.equal(result, home, "returns CODEX_HOME without minting");
  assert.equal(calls(), 0, "did not call the refresh grant");
});

await check("returns undefined when the vault has no openai-codex credential", async () => {
  const piDir = freshPiDir(false);
  freshCodexHome();
  const calls = stubFetch(OK_TOKENS);

  const result = await ensureCodexAuth(piDir);
  assert.equal(result, undefined);
  assert.equal(calls(), 0);
});

await check("returns undefined and writes nothing when the refresh grant fails", async () => {
  const piDir = freshPiDir();
  const home = freshCodexHome();
  stubFetch({ error: "invalid_grant" }, false);

  const result = await ensureCodexAuth(piDir);
  assert.equal(result, undefined);
  assert.ok(!fs.existsSync(path.join(home, "auth.json")), "no auth.json written on failure");
  // Vault left untouched (still the original refresh token).
  const stored = await createCredentialVault(piDir).read("openai-codex");
  assert.equal(stored?.refresh, "old-refresh");
});

await check("returns undefined when a partial token response omits the id_token", async () => {
  const piDir = freshPiDir();
  const home = freshCodexHome();
  stubFetch({ access_token: "a", refresh_token: "r", expires_in: 3600 }); // no id_token

  const result = await ensureCodexAuth(piDir);
  assert.equal(result, undefined);
  assert.ok(!fs.existsSync(path.join(home, "auth.json")));
});

await check("ensureCodexTrusted adds a missing project trust entry", async () => {
  const home = freshCodexHome();
  const ws = "/home/user/proj";
  ensureCodexTrusted(ws);
  const toml = fs.readFileSync(path.join(home, "config.toml"), "utf8");
  assert.ok(toml.includes(`[projects."${ws}"]`), "project header written");
  assert.match(toml, /trust_level = "trusted"/);
});

await check("ensureCodexTrusted is idempotent — no duplicate entry", async () => {
  const home = freshCodexHome();
  const ws = "/home/user/proj";
  ensureCodexTrusted(ws);
  ensureCodexTrusted(ws);
  const toml = fs.readFileSync(path.join(home, "config.toml"), "utf8");
  const count = toml.split(`[projects."${ws}"]`).length - 1;
  assert.equal(count, 1, "exactly one trust block for the workspace");
});

await check("ensureCodexTrusted preserves an existing (differently-set) trust level", async () => {
  const home = freshCodexHome();
  const ws = "/home/user/proj";
  const original = `[projects."${ws}"]\ntrust_level = "untrusted"\n`;
  fs.writeFileSync(path.join(home, "config.toml"), original);
  ensureCodexTrusted(ws);
  const toml = fs.readFileSync(path.join(home, "config.toml"), "utf8");
  assert.ok(toml.includes(`trust_level = "untrusted"`), "existing level untouched");
  assert.ok(!toml.includes(`trust_level = "trusted"`), "did not append a second block");
});

await check("ensureCodexTrusted appends without corrupting a prior table", async () => {
  const home = freshCodexHome();
  fs.writeFileSync(path.join(home, "config.toml"), `[tui]\ntheme = "dark"`); // no trailing newline
  ensureCodexTrusted("/ws/a");
  const toml = fs.readFileSync(path.join(home, "config.toml"), "utf8");
  assert.ok(toml.includes(`theme = "dark"`), "prior content preserved");
  assert.ok(toml.includes(`\n[projects."/ws/a"]`), "new table starts on its own line");
});

if (failures > 0) {
  console.error(`\n${failures} Codex auth test(s) failed.`);
  process.exit(1);
}
console.log("\nAll Codex auth tests passed.");
