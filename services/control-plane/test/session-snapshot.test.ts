// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { createPgMemStore } from "../src/pg-mem-store.js";

async function makeStore() {
  const store = createPgMemStore();
  await store.init();
  const account = await store.findOrCreateAccount("snap@example.com");
  return { store, acct: account.id };
}

// Store, overwrite, read back, and delete an opaque snapshot blob, keyed by
// (account, session) so it survives the owning machine's teardown.
{
  const { store, acct } = await makeStore();
  assert.equal(await store.getSessionSnapshot(acct, "sess-1"), undefined);

  await store.setSessionSnapshot(acct, "sess-1", "sealed-frame-v1");
  assert.equal((await store.getSessionSnapshot(acct, "sess-1"))?.ciphertext, "sealed-frame-v1");

  // Upsert on re-flush.
  await store.setSessionSnapshot(acct, "sess-1", "sealed-frame-v2");
  assert.equal((await store.getSessionSnapshot(acct, "sess-1"))?.ciphertext, "sealed-frame-v2");

  // Isolated per session.
  await store.setSessionSnapshot(acct, "sess-2", "other");
  assert.equal((await store.getSessionSnapshot(acct, "sess-1"))?.ciphertext, "sealed-frame-v2");

  // Cleanup after a successful restore.
  await store.deleteSessionSnapshot(acct, "sess-1");
  assert.equal(await store.getSessionSnapshot(acct, "sess-1"), undefined);
  assert.equal((await store.getSessionSnapshot(acct, "sess-2"))?.ciphertext, "other");
}

console.log("session-snapshot (control-plane): all tests passed");
