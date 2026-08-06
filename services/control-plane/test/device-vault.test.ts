// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { createPgMemStore } from "../src/pg-mem-store.js";

async function makeStore() {
  const store = createPgMemStore();
  await store.init();
  const account = await store.findOrCreateAccount("vault@example.com");
  return { store, acct: account.id };
}

// The producing device stores ciphertext; the CP never sees plaintext.
{
  const { store, acct } = await makeStore();
  assert.equal(await store.getDeviceVault(acct), undefined);
  await store.setDeviceVault(acct, "devA", "sealed-blob-v1");
  const v = await store.getDeviceVault(acct);
  assert.equal(v?.ciphertext, "sealed-blob-v1");
  assert.equal(v?.updatedByDevice, "devA");
  // Upsert: a later producer replaces the blob.
  await store.setDeviceVault(acct, "devB", "sealed-blob-v2");
  assert.equal((await store.getDeviceVault(acct))?.ciphertext, "sealed-blob-v2");
}

// A fresh device requests a wrapped key; the producer sees it and satisfies it;
// the request is then cleared and the wrapped key is retrievable by that device.
{
  const { store, acct } = await makeStore();
  assert.equal(await store.getDeviceVaultWrappedKey(acct, "devB"), undefined);

  await store.requestDeviceVaultWrappedKey(acct, "devB");
  const seenByA = await store.listDeviceVaultKeyRequests(acct, "devA");
  assert.deepEqual(seenByA.map((r) => r.devicePublicKey), ["devB"]);
  // A device never sees its own request.
  assert.equal((await store.listDeviceVaultKeyRequests(acct, "devB")).length, 0);

  await store.setDeviceVaultWrappedKey(acct, "devB", "devA", "wrapped-for-B");
  const wk = await store.getDeviceVaultWrappedKey(acct, "devB");
  assert.equal(wk?.wrappedKey, "wrapped-for-B");
  assert.equal(wk?.wrappedByPublicKey, "devA");
  // Satisfying the request removes it.
  assert.equal((await store.listDeviceVaultKeyRequests(acct, "devA")).length, 0);
}

// Requesting when a wrapped key already exists is a no-op (no stale request row).
{
  const { store, acct } = await makeStore();
  await store.setDeviceVaultWrappedKey(acct, "devB", "devA", "wrapped");
  await store.requestDeviceVaultWrappedKey(acct, "devB");
  assert.equal((await store.listDeviceVaultKeyRequests(acct, "devA")).length, 0);
}

console.log("device-vault (control-plane): all tests passed");
