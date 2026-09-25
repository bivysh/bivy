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
import { hostedVaultWriteRejection, legacyEscrowWriteRejection } from "../src/hosted-vault-policy.js";

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

await test("model-auth key requests wake peers once without provisioning or self-notification", async () => {
  const controlPlane = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const relay = fs.readFileSync(new URL("../../relay/src/index.ts", import.meta.url), "utf8");
  assert.match(controlPlane, /const queued = await store\.requestModelAuthWrappedKey/);
  assert.match(controlPlane, /if \(queued\)[\s\S]*excludeNodeId: node\.id, autoProvision: false/);
  assert.match(relay, /roomNodeId !== excludeNodeId/);
});

await test("only personal Machines replace hosted custody; a managed guest may publish the first snapshot", () => {
  const on = { provisioningEnabled: true };
  assert.equal(hostedVaultWriteRejection({ ...on, managedGuest: true, vaultActive: false }), null, "a setup guest publishes the initial snapshot");
  assert.deepEqual(hostedVaultWriteRejection({ ...on, managedGuest: true, vaultActive: true }), { status: 403, error: "managed guests cannot replace hosted credentials" });
  assert.equal(hostedVaultWriteRejection({ ...on, managedGuest: false, vaultActive: true }), null, "a personal Machine stays the authority");
  assert.equal(hostedVaultWriteRejection({ provisioningEnabled: false, managedGuest: false, vaultActive: false })?.status, 403);
});

await test("legacy key-only writes cannot overwrite an active filtered snapshot", () => {
  assert.deepEqual(legacyEscrowWriteRejection({ provisioningEnabled: true, vaultActive: true }), { status: 409, error: "filtered hosted credential vault already active" });
  assert.equal(legacyEscrowWriteRejection({ provisioningEnabled: true, vaultActive: false }), null);
  assert.equal(legacyEscrowWriteRejection({ provisioningEnabled: false, vaultActive: false })?.status, 403);
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
