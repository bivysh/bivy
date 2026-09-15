// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Gap 1: the durable session↔machine correlation must survive its node being
// unenrolled at teardown — that's the whole point (a torn-down destroy-lane node
// drops from the registry, but a send/rebuild must still find what to relaunch).
import assert from "node:assert/strict";
import { createPgMemStore } from "../src/pg-mem-store.js";

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

await test("set/get round-trips all launch params", async () => {
  const store = await makeStore();
  const acct = await store.findOrCreateAccount("a@example.com");
  const rec = await store.setSessionCorrelation(acct.id, {
    sessionId: "s1", nodeId: "eph-abc", provider: "fly",
    region: "iad", ttlMinutes: 60, repo: "o/r", setupId: "setup1", machineId: "m1", app: "app1", computeSource: "managed",
  });
  assert.equal(rec.sessionId, "s1");
  const got = await store.getSessionCorrelation(acct.id, "s1");
  assert.deepEqual(
    { ...got, updatedAt: undefined },
    { sessionId: "s1", nodeId: "eph-abc", provider: "fly", region: "iad", ttlMinutes: 60, repo: "o/r", setupId: "setup1", machineId: "m1", app: "app1", computeSource: "managed", updatedAt: undefined },
  );
});

await test("upsert overwrites on the same (account, session)", async () => {
  const store = await makeStore();
  const acct = await store.findOrCreateAccount("b@example.com");
  await store.setSessionCorrelation(acct.id, { sessionId: "s1", nodeId: "eph-1", provider: "fly" });
  await store.setSessionCorrelation(acct.id, { sessionId: "s1", nodeId: "eph-2", provider: "hetzner", region: "hel" });
  const got = await store.getSessionCorrelation(acct.id, "s1");
  assert.equal(got?.nodeId, "eph-2");
  assert.equal(got?.provider, "hetzner");
  assert.equal(got?.region, "hel");
  assert.equal((await store.listSessionCorrelations(acct.id)).length, 1);
});

await test("SURVIVES node unenroll (no nodes FK cascade) — the Gap 1 guarantee", async () => {
  const store = await makeStore();
  const acct = await store.findOrCreateAccount("c@example.com");
  await store.enrollNode(acct.id, "eph-xyz", "Ephemeral");
  await store.setSessionCorrelation(acct.id, { sessionId: "s9", nodeId: "eph-xyz", provider: "fly", setupId: "s1" });
  // Teardown unenrolls the node; the correlation must NOT cascade away.
  await store.removeNode(acct.id, "eph-xyz");
  const got = await store.getSessionCorrelation(acct.id, "s9");
  assert.ok(got, "correlation must survive node removal");
  assert.equal(got?.nodeId, "eph-xyz");
  assert.equal(got?.setupId, "s1");
});

await test("list is account-scoped; delete removes", async () => {
  const store = await makeStore();
  const a = await store.findOrCreateAccount("d@example.com");
  const b = await store.findOrCreateAccount("e@example.com");
  await store.setSessionCorrelation(a.id, { sessionId: "s1", nodeId: "n1", provider: "fly" });
  await store.setSessionCorrelation(b.id, { sessionId: "s2", nodeId: "n2", provider: "fly" });
  assert.equal((await store.listSessionCorrelations(a.id)).length, 1);
  await store.deleteSessionCorrelation(a.id, "s1");
  assert.equal((await store.listSessionCorrelations(a.id)).length, 0);
  assert.equal((await store.listSessionCorrelations(b.id)).length, 1);
});

await test("retired session deletion removes ciphertext and metadata, survives refresh, and fences late uploads", async () => {
  const store = await makeStore();
  const a = await store.findOrCreateAccount("retired@example.com");
  const b = await store.findOrCreateAccount("other@example.com");
  for (const account of [a, b]) {
    await store.setSessionCorrelation(account.id, { sessionId: "same-id", nodeId: "eph-retired", provider: "fly" });
    await store.setSessionSnapshot(account.id, "same-id", "sealed-content");
  }
  await store.enrollNode(a.id, "eph-retired", "Tear");
  await store.replaceNodeSessions(a.id, "eph-retired", [{ sessionId: "same-id", status: "idle" }]);
  await store.deleteRetiredSession(a.id, "same-id");
  await store.deleteRetiredSession(a.id, "same-id");
  assert.equal(await store.getSessionSnapshot(a.id, "same-id"), undefined);
  assert.equal(await store.getSessionCorrelation(a.id, "same-id"), undefined);
  assert.deepEqual(await store.listSessionCorrelations(a.id), []);
  await store.replaceNodeSessions(a.id, "eph-retired", [{ sessionId: "same-id", status: "idle" }]);
  assert.deepEqual(await store.listAccountSessions(a.id), []);
  assert.deepEqual(await store.listNodeSessions(a.id, "eph-retired"), []);
  await assert.rejects(() => store.setSessionSnapshot(a.id, "same-id", "late-ciphertext"), /deleted/);
  await assert.rejects(() => store.setSessionCorrelation(a.id, { sessionId: "same-id", nodeId: "eph-retired", provider: "fly" }), /deleted/);
  assert.ok(await store.getSessionSnapshot(b.id, "same-id"), "other account remains untouched");
});

console.log(`session-correlation: ${passed} test(s) passed`);
