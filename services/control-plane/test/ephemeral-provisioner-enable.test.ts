// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Ephemeral machines are OFF by default (fail-closed): a production deploy gets
// no ephemeral provisioning unless it sets EPHEMERAL_MACHINES_ENABLED=1. Local/dev
// (NODE_ENV !== "production") stays on so development isn't gated. planAutoProvision
// is the single choke point for server-initiated auto-launches, so the gate must
// veto even a hosted account whose routing points at a valid, provisionable config.
import assert from "node:assert/strict";
// Must be set before any hosted-crypto seal runs (setHostedProvisioning seals the
// provider token); read per-call. Mirrors hosted-room-key-escrow.test.ts.
process.env.HOSTED_CREDENTIAL_KEY = Buffer.alloc(32, 7).toString("base64");
import { createPgMemStore } from "../src/pg-mem-store.js";
import { planAutoProvision, ephemeralMachinesEnabled } from "../src/ephemeral-provisioner.js";

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

const CONFIG = { id: "cfg1", name: "Hosted", provider: "fly", region: "iad", ttlMinutes: 60, createdAt: "", updatedAt: "" };

// A hosted account whose routing points straight at an ephemeral config with a
// provider token present — the exact state that otherwise yields willProvision.
async function readyAccount() {
  const store = await makeStore();
  const acct = await store.findOrCreateAccount("e@example.com");
  await store.setHostedProvisioning(acct.id, { enabled: true, providerTokens: { fly: "fly-token" } });
  await store.setEphemeralConfigs(acct.id, [CONFIG]);
  await store.setQueueRouting(acct.id, { primary: { kind: "config", configId: "cfg1" } });
  return { store, acctId: acct.id };
}

// The helper decides the fail-closed matrix without a store. Pass an explicit env
// so the cases don't depend on the ambient process env.
await test("ephemeralMachinesEnabled: fail-closed matrix", async () => {
  assert.equal(ephemeralMachinesEnabled({ NODE_ENV: "production" } as never), false, "prod, unset → off");
  assert.equal(ephemeralMachinesEnabled({ NODE_ENV: "production", EPHEMERAL_MACHINES_ENABLED: "0" } as never), false, "prod, =0 → off");
  assert.equal(ephemeralMachinesEnabled({ NODE_ENV: "production", EPHEMERAL_MACHINES_ENABLED: "1" } as never), true, "prod, =1 → on");
  assert.equal(ephemeralMachinesEnabled({ NODE_ENV: "development" } as never), true, "dev, unset → on");
  assert.equal(ephemeralMachinesEnabled({} as never), true, "no NODE_ENV → on (local)");
  assert.equal(ephemeralMachinesEnabled({ NODE_ENV: "production", EPHEMERAL_MACHINES_ENABLED: "true" } as never), false, "only the exact '1' enables");
});

const PREV_ENABLED = process.env.EPHEMERAL_MACHINES_ENABLED;
const PREV_NODE_ENV = process.env.NODE_ENV;
try {
  await test("production without the flag refuses even a ready hosted account", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.EPHEMERAL_MACHINES_ENABLED;
    const { store, acctId } = await readyAccount();
    const plan = await planAutoProvision(store, acctId);
    assert.equal(plan.willProvision, false, "fail-closed: off unless explicitly enabled");
    assert.match(plan.reason, /EPHEMERAL_MACHINES_ENABLED/, "reason must name the flag");
    assert.equal(plan.targetConfigId, null, "no target when disabled at the deployment level");
  });

  await test("EPHEMERAL_MACHINES_ENABLED=1 lets a ready hosted account provision in production", async () => {
    process.env.NODE_ENV = "production";
    process.env.EPHEMERAL_MACHINES_ENABLED = "1";
    const { store, acctId } = await readyAccount();
    const plan = await planAutoProvision(store, acctId);
    assert.equal(plan.willProvision, true, "explicit opt-in provisions; baseline setup must be provisionable");
  });
} finally {
  if (PREV_ENABLED === undefined) delete process.env.EPHEMERAL_MACHINES_ENABLED;
  else process.env.EPHEMERAL_MACHINES_ENABLED = PREV_ENABLED;
  if (PREV_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = PREV_NODE_ENV;
}

console.log(`ephemeral-provisioner-enable: ${passed} test(s) passed`);
