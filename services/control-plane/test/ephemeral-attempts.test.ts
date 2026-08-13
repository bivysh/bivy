// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { createPgMemStore } from "../src/pg-mem-store.js";

const store = createPgMemStore();
await store.init();
const account = await store.findOrCreateAccount("ephemeral-attempts@example.com");
const now = new Date().toISOString();

await store.putHostedMachineAttempt({
  accountId: account.id,
  attemptId: "attempt-1",
  provider: "fly",
  configId: "cfg-1",
  nodeId: "eph-1",
  state: "requested",
  desired: { region: "iad", ttlMinutes: 15 },
  retryCount: 0,
  createdAt: now,
  updatedAt: now,
});
assert.equal((await store.listHostedMachineAccountIds()).includes(account.id), true, "an attempt is fleet-visible before machine tracking");
assert.equal((await store.listHostedMachineAttempts(account.id, true))[0]?.state, "requested");

await store.putHostedMachineAttempt({
  ...(await store.getHostedMachineAttempt(account.id, "attempt-1"))!,
  state: "provider-accepted",
  machine: { id: "machine-1", provider: "fly", attemptId: "attempt-1" },
  updatedAt: new Date().toISOString(),
});
assert.equal((await store.getHostedMachineAttempt(account.id, "attempt-1"))?.machine?.id, "machine-1", "provider identity survives a controller restart");

const holder = "worker-1";
assert.equal(await store.acquireHostedProvisionLease(account.id, holder, 30), true);
assert.equal(await store.renewHostedProvisionLease(account.id, holder, 60), true, "owner renews an active lease");
assert.equal(await store.renewHostedProvisionLease(account.id, "worker-2", 60), false, "non-owner cannot extend a lease");
await store.releaseHostedProvisionLease(account.id, holder);

await store.putHostedMachineAttempt({
  ...(await store.getHostedMachineAttempt(account.id, "attempt-1"))!,
  state: "deleted",
  updatedAt: new Date().toISOString(),
});
assert.equal((await store.listHostedMachineAttempts(account.id, true)).length, 0, "confirmed deletion leaves active reconciliation");

console.log("✓ durable machine attempts survive gaps, drive fleet scans, and use renewable ownership");
