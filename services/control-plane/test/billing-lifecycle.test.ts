// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { entitlementsForPlan } from "../src/store.js";
import { createPgMemStore } from "../src/pg-mem-store.js";

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`✓ ${name}`);
}

await test("free plan includes one hosted relay node", () => {
  const ent = entitlementsForPlan("free");
  assert.equal(ent.maxNodes, 1);
  assert.equal(ent.relayEnabled, true);
  assert.equal(ent.pushEnabled, false);
});

await test("billing lifecycle updates plan and subscription metadata", async () => {
  const store = createPgMemStore();
  await store.init();
  const account = await store.findOrCreateAccount("billing@example.com");
  assert.equal(account.plan, "free");
  assert.equal((await store.entitlements(account.id)).relayEnabled, true);

  await store.setSubscriptionState(account.id, {
    plan: "pro",
    stripeCustomerId: "cus_test_123",
    stripeSubscriptionId: "sub_test_123",
    subscriptionStatus: "active",
  });
  const upgraded = await store.getAccount(account.id);
  assert.equal(upgraded?.plan, "pro");
  assert.equal(upgraded?.stripeCustomerId, "cus_test_123");
  assert.equal(upgraded?.stripeSubscriptionId, "sub_test_123");
  assert.equal(upgraded?.subscriptionStatus, "active");
  const upgradedEnt = await store.entitlements(account.id);
  assert.equal(upgradedEnt.maxNodes, undefined, "paid: unlimited nodes");
  assert.equal(upgradedEnt.workQueueEnabled, true, "paid: hosted work queue");

  await store.setSubscriptionState(account.id, {
    plan: "free",
    stripeCustomerId: "cus_test_123",
    stripeSubscriptionId: "sub_test_123",
    subscriptionStatus: "canceled",
  });
  const downgraded = await store.getAccount(account.id);
  assert.equal(downgraded?.plan, "free");
  assert.equal(downgraded?.subscriptionStatus, "canceled");
  const ent = await store.entitlements(account.id);
  assert.equal(ent.maxNodes, 1);
  assert.equal(ent.relayEnabled, true);
  assert.equal(ent.workQueueEnabled, false, "downgrade drops the hosted work queue");
});

console.log(`\nbilling-lifecycle: ${passed} tests passed`);
