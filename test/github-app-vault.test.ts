// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  encryptGithubAppEnvelope,
  decryptGithubAppEnvelope,
  readLocalGithubAppVaultKey,
  writeLocalGithubAppVaultKey,
  forgetLocalGithubAppVaultKey,
  mintLocalGithubAppVaultKey,
} from "../src/github-app-vault.js";
import { generatePairingKeypair, deriveWrapKey, unwrapRoomKey, wrapRoomKey } from "../src/pairing-crypto.js";
import { seal } from "../src/e2e.js";
import { randomBytes } from "node:crypto";

let failures = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures++;
    console.log(`FAIL  ${name}\n      ${error instanceof Error ? error.message : String(error)}`);
  }
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bivy-github-app-vault-"));
}

// Not named PEM, so scripts/secret-scan.mjs's benign-context check recognizes
// this as a test fixture (same convention as test/github-apps.test.ts).
const FIXTURE_PEM = "-----BEGIN RSA PRIVATE KEY-----\nZmFrZQ==\n-----END RSA PRIVATE KEY-----\n";

// --- envelope encrypt/decrypt -----------------------------------------------

await check("envelope round-trips app id, key, and display metadata", () => {
  const vaultKeyB64 = randomBytes(32).toString("base64");
  const ciphertext = encryptGithubAppEnvelope(
    { appId: "123", privateKeyPem: FIXTURE_PEM, slug: "bivy-app", name: "Bivy", owner: "acme", ownerType: "Organization", hookId: "hook_1" },
    vaultKeyB64,
  );
  const envelope = decryptGithubAppEnvelope(ciphertext, vaultKeyB64);
  assert.equal(envelope.appId, "123");
  assert.equal(envelope.privateKeyPem, FIXTURE_PEM);
  assert.equal(envelope.slug, "bivy-app");
  assert.equal(envelope.name, "Bivy");
  assert.equal(envelope.owner, "acme");
  assert.equal(envelope.ownerType, "Organization");
  assert.equal(envelope.hookId, "hook_1");
});

await check("envelope tolerates missing optional display metadata", () => {
  const vaultKeyB64 = randomBytes(32).toString("base64");
  const ciphertext = encryptGithubAppEnvelope({ appId: "1", privateKeyPem: FIXTURE_PEM }, vaultKeyB64);
  const envelope = decryptGithubAppEnvelope(ciphertext, vaultKeyB64);
  assert.equal(envelope.appId, "1");
  assert.equal(envelope.slug, undefined);
  assert.equal(envelope.ownerType, undefined);
});

await check("decrypting with the wrong vault key fails", () => {
  const ciphertext = encryptGithubAppEnvelope({ appId: "1", privateKeyPem: FIXTURE_PEM }, randomBytes(32).toString("base64"));
  assert.throws(() => decryptGithubAppEnvelope(ciphertext, randomBytes(32).toString("base64")));
});

await check("a malformed decrypted payload (missing appId/key) is rejected, not silently accepted", () => {
  const vaultKeyB64 = randomBytes(32).toString("base64");
  // Seal something that isn't a valid envelope shape under the SAME key, so
  // decryption succeeds but the shape check must still reject it.
  const bogus = seal(Buffer.from(vaultKeyB64, "base64"), JSON.stringify({ notAnEnvelope: true }));
  assert.throws(() => decryptGithubAppEnvelope(bogus, vaultKeyB64));
});

// --- local vault-key cache ---------------------------------------------------

await check("a fresh data dir has no cached vault key for any app", () => {
  assert.equal(readLocalGithubAppVaultKey(tmpDir(), "1"), undefined);
});

await check("write then read round-trips, and is scoped per app id", () => {
  const dir = tmpDir();
  const key = randomBytes(32).toString("base64");
  writeLocalGithubAppVaultKey(dir, "1", key);
  assert.equal(readLocalGithubAppVaultKey(dir, "1"), key);
  assert.equal(readLocalGithubAppVaultKey(dir, "2"), undefined, "a different app id must not see app 1's key");
});

await check("forget drops only the named app's cached key", () => {
  const dir = tmpDir();
  const k1 = randomBytes(32).toString("base64");
  const k2 = randomBytes(32).toString("base64");
  writeLocalGithubAppVaultKey(dir, "1", k1);
  writeLocalGithubAppVaultKey(dir, "2", k2);
  forgetLocalGithubAppVaultKey(dir, "1");
  assert.equal(readLocalGithubAppVaultKey(dir, "1"), undefined);
  assert.equal(readLocalGithubAppVaultKey(dir, "2"), k2);
  // Forgetting an app that was never cached is a harmless no-op.
  forgetLocalGithubAppVaultKey(dir, "nope");
});

await check("mint overwrites any previously cached key for that app (rotation)", () => {
  const dir = tmpDir();
  const before = mintLocalGithubAppVaultKey(dir, "1");
  const after = mintLocalGithubAppVaultKey(dir, "1");
  assert.notEqual(before, after, "rotation must mint a genuinely different key");
  assert.equal(readLocalGithubAppVaultKey(dir, "1"), after);
});

await check("the vault-key cache file is written 0600 and is separate from model-auth's", () => {
  const dir = tmpDir();
  mintLocalGithubAppVaultKey(dir, "1");
  const file = path.join(dir, "github-app-vault.json");
  const mode = fs.statSync(file).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
  assert.notEqual(path.basename(file), "model-auth-vault.json");
});

await check("a corrupt cache file degrades to 'no cached key' rather than throwing", () => {
  const dir = tmpDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "github-app-vault.json"), "{ not json");
  assert.equal(readLocalGithubAppVaultKey(dir, "1"), undefined);
  // And writing after that recovers cleanly (doesn't preserve garbage).
  const key = mintLocalGithubAppVaultKey(dir, "1");
  assert.equal(readLocalGithubAppVaultKey(dir, "1"), key);
});

// --- rotation end-to-end: a removed node's cached key must stop working -----

await check("rotation scenario: a fresh vault key invalidates what a departed node cached", () => {
  const dir = tmpDir();
  const oldKey = mintLocalGithubAppVaultKey(dir, "1"); // what a since-removed node would have cached
  const ciphertextWithOldKey = encryptGithubAppEnvelope({ appId: "1", privateKeyPem: FIXTURE_PEM }, oldKey);

  // A surviving node rotates: mints a brand new key and re-encrypts.
  const newKey = mintLocalGithubAppVaultKey(dir, "1");
  const ciphertextWithNewKey = encryptGithubAppEnvelope({ appId: "1", privateKeyPem: FIXTURE_PEM }, newKey);

  // The removed node's cached (old) key can no longer open the new ciphertext.
  assert.throws(() => decryptGithubAppEnvelope(ciphertextWithNewKey, oldKey));
  // The old ciphertext is now orphaned from the surviving node's perspective too
  // (it only kept the new key), modeling "the old copy is simply superseded".
  assert.throws(() => decryptGithubAppEnvelope(ciphertextWithOldKey, newKey));
  // The new key correctly opens the new ciphertext.
  assert.deepEqual(decryptGithubAppEnvelope(ciphertextWithNewKey, newKey).privateKeyPem, FIXTURE_PEM);
});

// --- the "github-app-vault" HKDF purpose is a distinct channel -------------

await check("the github-app-vault wrap purpose is cryptographically distinct from model-auth-vault", () => {
  const nodeKeys = generatePairingKeypair();
  const deviceKeys = generatePairingKeypair();
  const modelAuthWrap = deriveWrapKey(nodeKeys.privateKeyB64, deviceKeys.publicKeyB64, "model-auth-vault");
  const githubAppWrap = deriveWrapKey(nodeKeys.privateKeyB64, deviceKeys.publicKeyB64, "github-app-vault");
  assert.notEqual(modelAuthWrap.toString("base64"), githubAppWrap.toString("base64"));

  // A vault key wrapped for the github-app purpose cannot be unwrapped with the
  // model-auth purpose's key (and vice versa) — the two credential classes
  // cannot cross-decrypt each other even though they share the same node/device
  // identity keypairs and the same ECDH shared secret.
  const vaultKey = randomBytes(32);
  const wrapped = wrapRoomKey(githubAppWrap, vaultKey);
  assert.throws(() => unwrapRoomKey(modelAuthWrap, wrapped));
  assert.ok(unwrapRoomKey(githubAppWrap, wrapped).equals(vaultKey));
});

await check("github-app-vault wrap key derivation is symmetric (node and device agree)", () => {
  const nodeKeys = generatePairingKeypair();
  const deviceKeys = generatePairingKeypair();
  const fromNode = deriveWrapKey(nodeKeys.privateKeyB64, deviceKeys.publicKeyB64, "github-app-vault");
  const fromDevice = deriveWrapKey(deviceKeys.privateKeyB64, nodeKeys.publicKeyB64, "github-app-vault");
  assert.equal(fromNode.toString("base64"), fromDevice.toString("base64"));
});

if (failures > 0) {
  console.log(`github-app-vault: ${failures} test(s) failed`);
  process.exit(1);
}
console.log("github-app-vault: all tests passed");
