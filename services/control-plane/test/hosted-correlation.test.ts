// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Gap 3 completion: a purely hosted-origin session (CP launched the machine, no
// device) must get a server-side session↔machine correlation on advert, so the
// auto-rebuild trigger can find the reuse node. Correlation is joined from the
// persisted hosted-machine record keyed by nodeId.
import assert from "node:assert/strict";
import { createPgMemStore } from "../src/pg-mem-store.js";
import { correlateHostedSessions } from "../src/hosted-correlation.js";

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

const HOSTED = { nodeId: "eph-hosted", provider: "fly", region: "iad", ttlMinutes: 60, setupId: "cfg1", id: "m1", repo: "o/r", app: "myapp" };

await test("writes a correlation for a hosted machine's new session", async () => {
  const store = await makeStore();
  const acct = await store.findOrCreateAccount("a@example.com");
  await store.enrollNode(acct.id, "eph-hosted", "Hosted");
  await store.setHostedMachines(acct.id, [HOSTED]);
  await correlateHostedSessions(store, { accountId: acct.id, id: "eph-hosted" }, [{ sessionId: "s1" }]);
  const corr = await store.getSessionCorrelation(acct.id, "s1");
  assert.ok(corr, "correlation must be written for a hosted-origin session");
  assert.equal(corr?.nodeId, "eph-hosted");
  assert.equal(corr?.provider, "fly");
  assert.equal(corr?.region, "iad");
  assert.equal(corr?.setupId, "cfg1");
  assert.equal(corr?.machineId, "m1");
});

await test("does NOT write for a node with no hosted-machine record", async () => {
  const store = await makeStore();
  const acct = await store.findOrCreateAccount("b@example.com");
  await store.enrollNode(acct.id, "laptop", "Laptop");
  // No setHostedMachines → this is a normal persistent/device node.
  await correlateHostedSessions(store, { accountId: acct.id, id: "laptop" }, [{ sessionId: "s2" }]);
  assert.equal(await store.getSessionCorrelation(acct.id, "s2"), undefined);
});

await test("does NOT clobber an existing (device-recorded) correlation", async () => {
  const store = await makeStore();
  const acct = await store.findOrCreateAccount("c@example.com");
  await store.enrollNode(acct.id, "eph-hosted", "Hosted");
  await store.setHostedMachines(acct.id, [HOSTED]);
  // Device already recorded a richer row (different machineId) — must be preserved.
  await store.setSessionCorrelation(acct.id, { sessionId: "s3", nodeId: "eph-hosted", provider: "fly", machineId: "device-m" });
  await correlateHostedSessions(store, { accountId: acct.id, id: "eph-hosted" }, [{ sessionId: "s3" }]);
  assert.equal((await store.getSessionCorrelation(acct.id, "s3"))?.machineId, "device-m");
});

await test("enables planRestoreProvision: correlation → nodeId resolves for rebuild", async () => {
  const store = await makeStore();
  const acct = await store.findOrCreateAccount("d@example.com");
  await store.enrollNode(acct.id, "eph-hosted", "Hosted");
  await store.setHostedMachines(acct.id, [HOSTED]);
  await correlateHostedSessions(store, { accountId: acct.id, id: "eph-hosted" }, [{ sessionId: "s4" }]);
  // What planRestoreProvision does: correlation(targetSessionId) → nodeId.
  const corr = await store.getSessionCorrelation(acct.id, "s4");
  assert.equal(corr?.nodeId, "eph-hosted", "rebuild can now resolve the reuse node with no device record");
});

console.log(`hosted-correlation: ${passed} test(s) passed`);
