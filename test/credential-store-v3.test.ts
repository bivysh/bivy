// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Guards the phase-2 store wiring: an existing v2 on-disk vault must migrate to v3
// transparently, the public surface must keep returning today's provider-keyed
// shapes, and the persisted encoding must become v3. This is the highest-stakes
// path (an existing user's logins across the upgrade), so it is tested directly.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

import { seal, open } from "../src/e2e.js";
import { createCredentialVault } from "../src/runtime/credential-store.js";

function freshVaultDir(): { dir: string; key: Buffer } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-vault-v3-"));
  const key = randomBytes(32);
  fs.writeFileSync(path.join(dir, "auth.key"), `${key.toString("base64")}\n`, { mode: 0o600 });
  return { dir, key };
}

/** Seal a document exactly as the store persists it (`<ciphertext>\n`). */
function writeBlob(dir: string, key: Buffer, document: unknown): void {
  fs.writeFileSync(path.join(dir, "auth.enc"), `${seal(key, JSON.stringify(document))}\n`, { mode: 0o600 });
}

/** Decrypt and parse the on-disk vault. */
function readBlob(dir: string, key: Buffer): any {
  return JSON.parse(open(key, fs.readFileSync(path.join(dir, "auth.enc"), "utf8").trim()));
}

// --- an existing v2 vault is read through the v3 surface --------------------
{
  const { dir, key } = freshVaultDir();
  writeBlob(dir, key, {
    v: 2,
    providers: {
      anthropic: { type: "api_key", key: "sk-existing", updatedAt: 111 },
      openai: { type: "oauth", access: "acc", refresh: "ref", expires: 999, refreshedAt: 222 },
    },
    deletedAt: { grok: 333 },
  });

  const store = createCredentialVault(dir);

  // read() still returns the provider's default credential, metadata-stripped.
  assert.deepEqual(await store.read("anthropic"), { type: "api_key", key: "sk-existing" });
  const oauth = await store.read("openai");
  assert.equal(oauth?.type, "oauth");
  assert.equal((oauth as any).refreshedAt, 222, "oauth content (refreshedAt) survives migration");

  // list() enumerates the migrated providers with their types.
  const list = await store.list();
  const byId = new Map(list.map((i) => [i.providerId, i]));
  assert.equal(byId.get("anthropic")?.type, "api_key");
  assert.equal(byId.get("openai")?.type, "oauth");
  assert.equal(byId.get("openai")?.expiresAt, 999);

  // exportAll() stays provider-keyed, with the store stamp re-attached for merge.
  const exported = await store.exportAll();
  assert.equal((exported.anthropic as any).key, "sk-existing");
  assert.equal((exported.anthropic as any).updatedAt, 111, "updatedAt re-attached to the wire credential");
  // exportTombstones() stays provider-keyed.
  assert.deepEqual(await store.exportTombstones(), { grok: 333 });

  fs.rmSync(dir, { recursive: true, force: true });
  console.log("v2 vault reads through the v3 surface OK");
}

// --- a write upgrades the persisted encoding to v3 --------------------------
{
  const { dir, key } = freshVaultDir();
  writeBlob(dir, key, { v: 2, providers: { anthropic: { type: "api_key", key: "old" } }, deletedAt: {} });

  const store = createCredentialVault(dir);
  await store.setApiKey("anthropic", "new");

  const disk = readBlob(dir, key);
  assert.equal(disk.v, 3, "the vault is persisted as v3 after a write");
  assert.ok(disk.credentials["anthropic:default"], "the credential lives under its provider:default key");
  assert.equal(disk.credentials["anthropic:default"].source.kind, "stored");
  assert.equal(disk.credentials["anthropic:default"].source.cred.key, "new");
  assert.equal(disk.credentials["anthropic:default"].source.cred.updatedAt, undefined, "store stamp is not embedded in the cred");
  assert.equal(typeof disk.credentials["anthropic:default"].updatedAt, "number", "the record carries the store stamp");
  assert.equal(await store.read("anthropic").then((c) => (c as any).key), "new");

  fs.rmSync(dir, { recursive: true, force: true });
  console.log("write upgrades persisted encoding to v3 OK");
}

// --- delete tombstones, and importAll converges (rotation-safe) -------------
{
  const { dir } = freshVaultDir();
  const store = createCredentialVault(dir);

  await store.setApiKey("anthropic", "a1");
  await store.delete("anthropic");
  assert.equal(await store.read("anthropic"), undefined, "deleted credential is gone");
  assert.ok((await store.exportTombstones()).anthropic, "a provider tombstone is retained");

  // A lagging snapshot must not resurrect a tombstoned credential.
  const imported = await store.importAll({ anthropic: { type: "api_key", key: "stale" } });
  assert.equal(imported, 0, "an older snapshot cannot resurrect a fresh tombstone");
  assert.equal(await store.read("anthropic"), undefined);

  // A brand-new provider from a snapshot is imported.
  const n = await store.importAll({ openai: { type: "api_key", key: "sk-new" } });
  assert.equal(n, 1);
  assert.equal(await store.read("openai").then((c) => (c as any).key), "sk-new");

  fs.rmSync(dir, { recursive: true, force: true });
  console.log("delete tombstone + importAll convergence OK");
}

console.log("credential-store-v3: all tests passed");
