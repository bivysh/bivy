// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { createPgMemStore } from "../src/pg-mem-store.js";
import { ConcurrentAttemptUpdateError } from "../src/store.js";

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

// Version-fenced writes: two "reconciler passes" reading the same attempt
// concurrently must not both win. The second writer's stale expectedVersion
// is rejected rather than silently overwriting the first writer's transition.
{
  const acct = await store.findOrCreateAccount("ephemeral-attempts-fencing@example.com");
  const at = new Date().toISOString();
  const written = await store.putHostedMachineAttempt({
    accountId: acct.id, attemptId: "fenced-1", provider: "hetzner", nodeId: "eph-fenced",
    state: "tracked", desired: {}, retryCount: 0, createdAt: at, updatedAt: at,
  });
  assert.equal(written.version, 1, "a fresh insert starts at version 1");

  // Two reconciler passes both read the same row (version 1) before either writes.
  const readByPassA = await store.getHostedMachineAttempt(acct.id, "fenced-1");
  const readByPassB = await store.getHostedMachineAttempt(acct.id, "fenced-1");
  assert.equal(readByPassA?.version, 1);
  assert.equal(readByPassB?.version, 1);

  // Pass A wins: writes with the version it read.
  const afterA = await store.putHostedMachineAttempt(
    { ...readByPassA!, state: "deleting", updatedAt: new Date().toISOString() },
    { expectedVersion: readByPassA!.version },
  );
  assert.equal(afterA.state, "deleting");
  assert.equal(afterA.version, 2, "version increments on a fenced write");

  // Pass B loses: it still holds the stale version-1 read and must be
  // rejected, not silently clobber pass A's "deleting" transition.
  await assert.rejects(
    () => store.putHostedMachineAttempt(
      { ...readByPassB!, state: "requested", updatedAt: new Date().toISOString() },
      { expectedVersion: readByPassB!.version },
    ),
    ConcurrentAttemptUpdateError,
    "a stale expectedVersion is rejected rather than applied",
  );
  const finalRow = await store.getHostedMachineAttempt(acct.id, "fenced-1");
  assert.equal(finalRow?.state, "deleting", "the losing writer's update never landed");
  assert.equal(finalRow?.version, 2);

  // Unfenced writes (no expectedVersion — the shape every pre-existing call
  // site uses) remain last-write-wins, unaffected by fencing.
  const unfenced = await store.putHostedMachineAttempt({ ...finalRow!, state: "deleted", updatedAt: new Date().toISOString() });
  assert.equal(unfenced.state, "deleted");
  assert.equal(unfenced.version, 3);

  console.log("✓ version-fenced attempt writes reject a stale concurrent update");
}

// listHostedEnabledAccountIds is a superset of listHostedMachineAccountIds:
// it must find an account with hosted provisioning enabled even when nothing
// is currently tracked — the orphan sweep depends on this to visit accounts
// whose tracking itself may have been lost.
{
  const acct = await store.findOrCreateAccount("ephemeral-attempts-hosted-enabled@example.com");
  assert.equal((await store.listHostedEnabledAccountIds()).includes(acct.id), false, "not yet enabled");
  await store.setHostedProvisioning(acct.id, { enabled: true });
  assert.equal((await store.listHostedEnabledAccountIds()).includes(acct.id), true, "enabled with zero tracked machines is still visible");
  assert.equal((await store.listHostedMachineAccountIds()).includes(acct.id), false, "…but not fleet-visible, since nothing is tracked");
  console.log("✓ listHostedEnabledAccountIds finds hosted-enabled accounts with nothing currently tracked");
}
