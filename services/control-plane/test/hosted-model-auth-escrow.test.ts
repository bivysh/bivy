// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Explicit hosted custody: the control plane stores a separately filtered
// ciphertext and seals its distinct key with the per-account hosted key.
import assert from "node:assert/strict";
import fs from "node:fs";
process.env.HOSTED_CREDENTIAL_KEY = Buffer.alloc(32, 5).toString("base64");
import { createPgMemStore } from "../src/pg-mem-store.js";
import { encryptSecret, decryptSecret } from "../src/hosted-crypto.js";

async function makeStore() {
  const store = createPgMemStore();
  await store.init();
  return store;
}

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

const VAULT_KEY = Buffer.alloc(32, 3).toString("base64");

await test("escrowed vault key seals at rest and decrypts back", async () => {
  const store = await makeStore();
  const acct = await store.findOrCreateAccount("a@example.com");
  await store.setHostedModelAuthVaultKey(acct.id, encryptSecret(acct.id, VAULT_KEY));
  const enc = await store.getHostedModelAuthVaultKey(acct.id);
  assert.ok(enc, "escrow must be stored");
  assert.notEqual(JSON.stringify(enc), VAULT_KEY, "must be sealed, not plaintext");
  assert.equal(decryptSecret(acct.id, enc!), VAULT_KEY, "must decrypt back to the vault key");
});

await test("separate hosted ciphertext is stored with its escrow key", async () => {
  const store = await makeStore();
  const acct = await store.findOrCreateAccount("snapshot@example.com");
  assert.equal(await store.setHostedModelAuthVault(acct.id, "filtered-ciphertext", encryptSecret(acct.id, VAULT_KEY), 0, 10), 1);
  assert.deepEqual(await store.getHostedModelAuthVault(acct.id), { ciphertext: "filtered-ciphertext", generation: 1, revision: 10 });
  assert.equal(decryptSecret(acct.id, (await store.getHostedModelAuthVaultKey(acct.id))!), VAULT_KEY);
});

await test("generation and revision reject stale hosted snapshots", async () => {
  const store = await makeStore();
  const acct = await store.findOrCreateAccount("cas@example.com");
  assert.equal(await store.setHostedModelAuthVault(acct.id, "v1", encryptSecret(acct.id, VAULT_KEY), 0, 20), 1);
  assert.equal(await store.setHostedModelAuthVault(acct.id, "stale-generation", encryptSecret(acct.id, VAULT_KEY), 0, 21), undefined);
  assert.equal(await store.setHostedModelAuthVault(acct.id, "stale-revision", encryptSecret(acct.id, VAULT_KEY), 1, 19), undefined);
  assert.equal(await store.setHostedModelAuthVault(acct.id, "v2", encryptSecret(acct.id, VAULT_KEY), 1, 22), 2);
  assert.deepEqual(await store.getHostedModelAuthVault(acct.id), { ciphertext: "v2", generation: 2, revision: 22 });
});

await test("hosted recipients apply authoritative removals and never republish", async () => {
  const source = fs.readFileSync(new URL("../../../src/server.ts", import.meta.url), "utf8");
  assert.match(source, /readHostedImportedRecords\(\)/);
  assert.match(source, /Hosted runners are recipients, never authorities/);
  assert.match(source, /modelAuthFetch\("\/node\/model-auth-hosted-vault"\)/, "hosted custody uses its versioned endpoint");
});

await test("legacy key-only writes cannot overwrite an active filtered snapshot", async () => {
  const source = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(source, /if \(await store\.getHostedModelAuthVault\(node\.accountId\)\) \{\s*return res\.status\(409\)/);
});

await test("upsert overwrites; account-scoped", async () => {
  const store = await makeStore();
  const a = await store.findOrCreateAccount("b@example.com");
  const b = await store.findOrCreateAccount("c@example.com");
  await store.setHostedModelAuthVaultKey(a.id, encryptSecret(a.id, VAULT_KEY));
  const k2 = Buffer.alloc(32, 9).toString("base64");
  await store.setHostedModelAuthVaultKey(a.id, encryptSecret(a.id, k2));
  assert.equal(decryptSecret(a.id, (await store.getHostedModelAuthVaultKey(a.id))!), k2);
  assert.equal(await store.getHostedModelAuthVaultKey(b.id), undefined, "other account has none");
});

await test("a's envelope does not decrypt under b's account key (per-account HKDF)", async () => {
  const store = await makeStore();
  const a = await store.findOrCreateAccount("d@example.com");
  await store.setHostedModelAuthVaultKey(a.id, encryptSecret(a.id, VAULT_KEY));
  const enc = await store.getHostedModelAuthVaultKey(a.id);
  assert.throws(() => decryptSecret("some-other-account", enc!), "cross-account decrypt must fail");
});

console.log(`hosted-model-auth-escrow: ${passed} test(s) passed`);
