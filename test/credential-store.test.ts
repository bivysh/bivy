// Unit tests for Bivy's app-owned credential store (src/runtime/credential-store.ts).
//
// The cases that matter are the ones that motivated owning the store: encryption
// at rest (no plaintext token on disk), serialization of concurrent writes (a
// read-then-write loses an OAuth refresh), rotation-safe import, corruption
// tolerance, and the one-time migration from a legacy plaintext auth.json.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BivyCredentialStore, createCredentialVault, migrateVaultDir } from "../src/runtime/credential-store.js";

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
  return fs.mkdtempSync(path.join(os.tmpdir(), "bivy-credstore-"));
}

await check("encrypts at rest — the token never appears as plaintext on disk", async () => {
  const dir = tmpDir();
  const store = new BivyCredentialStore(dir);
  await store.setApiKey("openai", "sk-super-secret-123");

  const encPath = path.join(dir, "auth.enc");
  assert.ok(fs.existsSync(encPath), "auth.enc is written");
  assert.ok(fs.existsSync(path.join(dir, "auth.key")), "a wrapping key is written");
  const raw = fs.readFileSync(encPath, "utf8");
  assert.ok(!raw.includes("sk-super-secret-123"), "the api key must not be present in the ciphertext");
  assert.ok(!raw.includes("openai"), "the provider id must not be present in the ciphertext");

  // 0600 on both the vault and the key.
  if (os.platform() !== "win32") {
    assert.equal(fs.statSync(encPath).mode & 0o777, 0o600, "auth.enc is 0600");
    assert.equal(fs.statSync(path.join(dir, "auth.key")).mode & 0o777, 0o600, "auth.key is 0600");
  }

  const roundTrip = await store.read("openai");
  assert.equal(roundTrip?.type, "api_key");
  assert.equal((roundTrip as { key?: string }).key, "sk-super-secret-123", "decrypts back to the original key");
});

await check("read/list/delete behave", async () => {
  const store = createCredentialVault(tmpDir());
  assert.equal(await store.read("nobody"), undefined, "missing entry reads undefined");
  await store.setApiKey("openai", "sk-1");
  await store.modify("anthropic", async () => ({ type: "oauth", access: "at", refresh: "rt", expires: 123 }));

  const list = [...(await store.list())].sort((a, b) => a.providerId.localeCompare(b.providerId));
  assert.deepEqual(list, [
    // expiresAt rides along for oauth entries (the stored credential's `expires`)
    // so callers (e.g. the cross-node provider-summary push) can tell an expired
    // login from a live one without touching the token itself.
    { providerId: "anthropic", type: "oauth", expiresAt: 123 },
    { providerId: "openai", type: "api_key" },
  ]);

  await store.delete("openai");
  assert.equal(await store.read("openai"), undefined, "deleted entry is gone");
  assert.equal((await store.read("anthropic"))?.type, "oauth", "other entries survive delete");
});

await check("concurrent modifies on one provider serialize instead of clobbering", async () => {
  const store = createCredentialVault(tmpDir());
  await store.modify("anthropic", async () => ({ type: "oauth", access: "v0", refresh: "r0", expires: 0 }));

  const observed: string[] = [];
  // Two writers race on the same provider. Serialization means the second one
  // must observe the first one's write (v1), never the original (v0).
  const refresh = store.modify("anthropic", async (current) => {
    observed.push(`refresh saw ${(current as { access?: string })?.access}`);
    await new Promise((r) => setTimeout(r, 20));
    return { type: "oauth", access: "v1", refresh: "r1", expires: 1 };
  });
  const importer = store.modify("anthropic", async (current) => {
    observed.push(`import saw ${(current as { access?: string })?.access}`);
    return current; // leave unchanged
  });
  await Promise.all([refresh, importer]);

  assert.deepEqual(observed, ["refresh saw v0", "import saw v1"], "the import must see the refreshed value, not the stale one");
  assert.equal((await store.read("anthropic"))?.access, "v1");
});

await check("importAll is rotation-safe: never downgrades a locally-fresher OAuth token", async () => {
  const store = createCredentialVault(tmpDir());
  await store.modify("anthropic", async () => ({ type: "oauth", access: "local-fresh", refresh: "r2", expires: 9_000 }));
  await store.modify("openai-codex", async () => ({ type: "oauth", access: "local-only", refresh: "r", expires: 5_000 }));

  await store.importAll({
    anthropic: { type: "oauth", access: "stale-remote", refresh: "r0", expires: 1_000 }, // older → must lose
    openrouter: { type: "api_key", key: "or-key" }, // genuinely new → imported
  });

  const all = await store.exportAll();
  assert.equal(all.anthropic.type === "oauth" && all.anthropic.access, "local-fresh", "fresher local OAuth token wins");
  assert.ok(all["openai-codex"], "a local login absent from the snapshot is preserved");
  assert.equal(all.openrouter.type === "api_key" && all.openrouter.key, "or-key", "new providers are imported");
});

await check("a corrupt vault reads as empty rather than throwing", async () => {
  const dir = tmpDir();
  const store = new BivyCredentialStore(dir);
  await store.setApiKey("openai", "sk-1"); // mints the key + a valid blob
  fs.writeFileSync(path.join(dir, "auth.enc"), "not-valid-ciphertext");
  assert.equal(await store.read("openai"), undefined, "undecryptable vault reads empty");
  // And is recoverable — a subsequent write replaces it.
  await store.setApiKey("openai", "sk-2");
  assert.equal((await store.read("openai") as { key?: string }).key, "sk-2");
});

await check("imports a legacy plaintext auth.json on first use, then encrypts it", async () => {
  const dir = tmpDir();
  fs.writeFileSync(
    path.join(dir, "auth.json"),
    JSON.stringify({ openai: { type: "api_key", key: "sk-legacy" }, anthropic: { type: "oauth", access: "at", refresh: "rt", expires: 1 } }),
  );
  const store = new BivyCredentialStore(dir);
  assert.equal((await store.read("openai") as { key?: string }).key, "sk-legacy", "legacy api key is imported");
  assert.ok(fs.existsSync(path.join(dir, "auth.enc")), "the encrypted vault is materialized");
  const enc = fs.readFileSync(path.join(dir, "auth.enc"), "utf8");
  assert.ok(!enc.includes("sk-legacy"), "the migrated key is encrypted, not plaintext");
});

await check("materializePlaintext is write-if-changed — an unchanged projection is not rewritten", async () => {
  const dir = tmpDir();
  const store = new BivyCredentialStore(dir);
  await store.setApiKey("openai", "sk-1");
  const authJson = path.join(dir, "auth.json");
  store.materializePlaintext();
  const ino1 = fs.statSync(authJson).ino;
  store.materializePlaintext(); // no vault change → must not rewrite (stable inode)
  assert.equal(fs.statSync(authJson).ino, ino1, "unchanged projection keeps the same file (no rewrite)");
  // A real vault change DOES re-project.
  await store.setApiKey("anthropic", "sk-2");
  store.materializePlaintext();
  const projected = JSON.parse(fs.readFileSync(authJson, "utf8"));
  assert.ok(projected.anthropic, "new credential reaches the projection");
});

await check("importAll skips the write (and re-encrypt) when nothing changes", async () => {
  const dir = tmpDir();
  const store = new BivyCredentialStore(dir);
  await store.setApiKey("openai", "sk-1");
  const enc = path.join(dir, "auth.enc");
  const before = fs.readFileSync(enc);
  const imported = await store.importAll({ openai: { type: "api_key", key: "sk-1" } });
  assert.equal(imported, 0, "no new providers");
  assert.ok(before.equals(fs.readFileSync(enc)), "vault bytes untouched — no needless re-encrypt");
  // A changed value must still persist.
  await store.importAll({ openai: { type: "api_key", key: "sk-2" } });
  assert.equal((await store.read("openai") as { key?: string }).key, "sk-2", "changed value persisted");
});

await check("migrateVaultDir moves a legacy vault, preserves the decrypted logins, and is idempotent", async () => {
  const root = tmpDir();
  const legacyDir = path.join(root, "pi");
  const credsDir = path.join(root, "credentials");
  // Seed a vault (auth.enc + auth.key) in the legacy dir, plus a plaintext
  // auth.json that must stay behind (it's the agent's own TUI file).
  const legacy = new BivyCredentialStore(legacyDir);
  await legacy.setApiKey("openai", "sk-legacy");
  legacy.materializePlaintext();
  assert.ok(fs.existsSync(path.join(legacyDir, "auth.enc")), "precondition: legacy vault exists");

  const moved = migrateVaultDir(legacyDir, credsDir);
  assert.equal(moved, true, "reports it moved a vault");
  assert.ok(fs.existsSync(path.join(credsDir, "auth.enc")), "auth.enc relocated");
  assert.ok(fs.existsSync(path.join(credsDir, "auth.key")), "auth.key relocated");
  assert.ok(!fs.existsSync(path.join(legacyDir, "auth.enc")), "legacy auth.enc removed");
  assert.ok(fs.existsSync(path.join(legacyDir, "auth.json")), "plaintext auth.json stays in the agent dir");

  // The relocated vault still decrypts to the same login.
  const relocated = new BivyCredentialStore(credsDir);
  assert.equal((await relocated.read("openai") as { key?: string }).key, "sk-legacy", "login survives the move");

  // Idempotent: a second run is a no-op and never clobbers the live vault.
  await relocated.setApiKey("anthropic", "sk-new");
  assert.equal(migrateVaultDir(legacyDir, credsDir), false, "no-op once the destination has a vault");
  assert.equal((await relocated.read("anthropic") as { key?: string }).key, "sk-new", "destination vault untouched");
});

if (failures > 0) {
  console.error(`credential-store: ${failures} test(s) failed`);
  process.exit(1);
}
console.log("credential-store: all tests passed");
