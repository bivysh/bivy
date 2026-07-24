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

await test("free plan is feature-complete, capped only by rolling weekly runs", () => {
  const ent = entitlementsForPlan("free");
  assert.equal(ent.maxNodes, undefined, "free: unlimited nodes");
  assert.equal(ent.relayEnabled, true);
  assert.equal(ent.pushEnabled, true, "free: push included");
  assert.equal(ent.ephemeralEnabled, true, "free: ephemeral included");
  assert.equal(ent.weeklyRunLimit, 10, "free: 10 runs / rolling 7 days is the only cap");
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
  assert.equal(upgradedEnt.weeklyRunLimit, undefined, "paid: unlimited runs (no cap)");

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
  assert.equal(ent.maxNodes, undefined, "downgrade keeps unlimited nodes");
  assert.equal(ent.relayEnabled, true);
  // The queue itself stays on free — a downgrade drops the UNLIMITED allowance,
  // re-imposing the free rolling run cap rather than turning the feature off.
  assert.equal(ent.workQueueEnabled, true, "downgrade keeps the queue, metered");
  assert.equal(ent.weeklyRunLimit, 10, "downgrade re-imposes the free rolling run cap");
});

console.log(`\nbilling-lifecycle: ${passed} tests passed`);
