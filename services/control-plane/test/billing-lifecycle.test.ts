// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { entitlementsForPlan, TRIAL_SESSIONS } from "../src/store.js";
import { createPgMemStore } from "../src/pg-mem-store.js";

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`✓ ${name}`);
}

await test("free plan is the hosted trial: lifetime session cap + ten weekly automations", () => {
  const ent = entitlementsForPlan("free");
  assert.equal(ent.maxNodes, undefined, "free: unlimited nodes");
  assert.equal(ent.relayEnabled, true);
  assert.equal(ent.pushEnabled, true, "free: push included");
  assert.equal(ent.ephemeralEnabled, true, "free: ephemeral included");
  assert.equal(ent.weeklyRunLimit, 10, "free: 10 unattended automations / rolling 7 days");
  assert.equal(ent.trialSessionLimit, TRIAL_SESSIONS, "free: lifetime hosted-session trial cap");
});

await test("paid plans have no lifetime session trial", () => {
  assert.equal(entitlementsForPlan("pro").trialSessionLimit, undefined, "pro: unlimited sessions");
  assert.equal(entitlementsForPlan("team").trialSessionLimit, undefined, "team: unlimited sessions");
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
  assert.equal(upgradedEnt.trialSessionLimit, undefined, "paid: no session trial (unlimited)");

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
  // The queue itself stays on free — a downgrade restores the included weekly
  // automation allowance rather than turning the feature off.
  assert.equal(ent.workQueueEnabled, true, "downgrade keeps the queue, metered");
  assert.equal(ent.weeklyRunLimit, 10, "downgrade restores the free automation allowance");
  assert.equal(ent.trialSessionLimit, TRIAL_SESSIONS, "downgrade restores the free session trial");
});

console.log(`\nbilling-lifecycle: ${passed} tests passed`);
