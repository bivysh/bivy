// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Fault-injection coverage for the durable ephemeral lifecycle hardening:
// confirmed-deletion finalizer semantics, enrollment rollback after a hopeless
// create, discover-based orphan recovery, and force-destroy bypassing TTL
// retention. Runs against a real (pg-mem) store rather than hand-rolled fakes
// so the attempt CRUD/CAS path is exercised for real, matching the pattern in
// ephemeral-attempts.test.ts.
import assert from "node:assert/strict";
process.env.HOSTED_CREDENTIAL_KEY = Buffer.alloc(32, 7).toString("base64");
import { createPgMemStore } from "../src/pg-mem-store.js";
import { providerCredentialFingerprint } from "../src/store.js";
import {
  reconcileHostedMachines,
  sweepOrphanProviderResources,
  type DestroyFn,
  type ObserveFn,
  type DiscoverFn,
} from "../src/ephemeral-provisioner.js";

const env = { cpBaseUrl: "https://cp", relayUrl: "wss://relay" };
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

async function accountWithHostedToken(store: ReturnType<typeof createPgMemStore>, email: string, provider = "hetzner", token = "tok-1") {
  const account = await store.findOrCreateAccount(email);
  await store.setHostedProvisioning(account.id, {
    enabled: true,
    providerTokens: { [provider]: token },
    validatedProviders: { [provider]: providerCredentialFingerprint(token) },
  });
  return account;
}

// --- Confirmed-deletion finalizer: destroy() accepted, not yet confirmed ----
// gone must be retained (not reaped), on the plain TTL-elapsed path, not only
// the boot-deadline path already covered in ephemeral-teardown.test.ts.
{
  const store = createPgMemStore();
  await store.init();
  const account = await accountWithHostedToken(store, "confirm-pending@example.com");
  const machine = { id: "srv-pending", provider: "hetzner", nodeId: "eph-pending", attemptId: "attempt-pending", createdAt: iso(200 * 60_000), ttlMinutes: 60, status: "running" };
  await store.setHostedMachines(account.id, [machine]);
  await store.putHostedMachineAttempt({
    accountId: account.id, attemptId: "attempt-pending", provider: "hetzner", nodeId: "eph-pending",
    state: "tracked", desired: {}, machine, retryCount: 0, createdAt: machine.createdAt, updatedAt: machine.createdAt,
  });

  let destroyed = 0;
  const destroy: DestroyFn = async () => { destroyed++; };
  // Pre-destroy observe (still running) then post-destroy confirm observe
  // (still running — the provider hasn't actually deleted it yet).
  let observed = 0;
  const observe: ObserveFn = async () => { observed++; return "running"; };

  const reaped = await reconcileHostedMachines(store, account.id, Date.now(), env, destroy, observe);
  assert.equal(reaped, 0, "not reaped while the provider still reports the resource present");
  assert.equal(destroyed, 1, "destroy is still attempted");
  assert.equal(observed, 2, "pre-check + post-destroy confirmation");
  const machines = await store.getHostedMachines(account.id);
  assert.equal(machines.length, 1, "the record stays tracked — it may still be billing");
  const attempt = await store.getHostedMachineAttempt(account.id, "attempt-pending");
  assert.equal(attempt?.state, "deleting", "attempt stays in-flight, not falsely finalized as deleted");
  assert.equal(attempt?.desiredState, "deleted", "intent to delete is recorded regardless of confirmation");

  console.log("✓ TTL-elapsed destroy accepted-but-unconfirmed keeps the machine tracked, not falsely reaped");
}

// --- Confirmed-deletion finalizer: destroy() accepted AND confirmed --------
{
  const store = createPgMemStore();
  await store.init();
  const account = await accountWithHostedToken(store, "confirm-gone@example.com");
  const machine = { id: "srv-gone", provider: "hetzner", nodeId: "eph-gone", attemptId: "attempt-gone", createdAt: iso(200 * 60_000), ttlMinutes: 60, status: "running" };
  await store.setHostedMachines(account.id, [machine]);
  await store.putHostedMachineAttempt({
    accountId: account.id, attemptId: "attempt-gone", provider: "hetzner", nodeId: "eph-gone",
    state: "tracked", desired: {}, machine, retryCount: 0, createdAt: machine.createdAt, updatedAt: machine.createdAt,
  });

  let call = 0;
  const destroy: DestroyFn = async () => {};
  const observe: ObserveFn = async () => { call++; return call === 1 ? "running" : "gone"; };

  const reaped = await reconcileHostedMachines(store, account.id, Date.now(), env, destroy, observe);
  assert.equal(reaped, 1);
  assert.deepEqual(await store.getHostedMachines(account.id), [], "confirmed-gone resource is dropped from inventory");
  const attempt = await store.getHostedMachineAttempt(account.id, "attempt-gone");
  assert.equal(attempt?.state, "deleted");

  console.log("✓ TTL-elapsed destroy confirmed gone finalizes the attempt and drops the inventory row");
}

// --- Force-destroy bypasses TTL grace ---------------------------------------
// A machine still well within its TTL must not be retained just because it's
// "not due yet" once its attempt's desiredState is "deleted" (a PWA
// force-destroy, or an abandoned create — see below).
{
  const store = createPgMemStore();
  await store.init();
  const account = await accountWithHostedToken(store, "force-destroy@example.com");
  const machine = { id: "srv-force", provider: "hetzner", nodeId: "eph-force", attemptId: "attempt-force", createdAt: iso(5 * 60_000), ttlMinutes: 60, status: "running" };
  await store.setHostedMachines(account.id, [machine]);
  await store.putHostedMachineAttempt({
    accountId: account.id, attemptId: "attempt-force", provider: "hetzner", nodeId: "eph-force",
    state: "working", desiredState: "deleted", desired: {}, machine, retryCount: 0, createdAt: machine.createdAt, updatedAt: machine.createdAt,
  });

  let destroyed = 0;
  const destroy: DestroyFn = async () => { destroyed++; };
  // Pre-check observe (still "running", so the early "already gone" fast
  // path doesn't short-circuit before the TTL/force-delete logic runs) then
  // post-destroy confirm observe ("gone", confirming the destroy landed).
  let observeCalls = 0;
  const observe: ObserveFn = async () => { observeCalls++; return observeCalls === 1 ? "running" : "gone"; };

  const reaped = await reconcileHostedMachines(store, account.id, Date.now(), env, destroy, observe);
  assert.equal(destroyed, 1, "destroy is attempted immediately despite 55 minutes of TTL remaining");
  assert.equal(reaped, 1);
  assert.deepEqual(await store.getHostedMachines(account.id), []);

  console.log("✓ a force-destroyed attempt (desiredState: deleted) is torn down immediately, not held for its TTL");
}

// --- Enrollment rollback: abandon after the retry ceiling -------------------
{
  const store = createPgMemStore();
  await store.init();
  const account = await accountWithHostedToken(store, "abandon@example.com", "fly", "fly-tok");
  await store.setEphemeralConfigs(account.id, [{ id: "cfg-1", name: "Recovered runner", provider: "fly", ttlMinutes: 60, createdAt: iso(0), updatedAt: iso(0) }]);
  const old = iso(60 * 60_000);
  await store.putHostedMachineAttempt({
    accountId: account.id, attemptId: "attempt-hopeless", provider: "fly", configId: "cfg-1", nodeId: "eph-hopeless",
    state: "failed", desired: { ttlMinutes: 60 }, retryCount: 8, lastError: "provider timeout", createdAt: old, updatedAt: old,
  });
  let removedNode: string | null = null;
  store.removeNode = async (_accountId: string, nodeId: string) => { removedNode = nodeId; return true; };

  await reconcileHostedMachines(store, account.id, Date.now(), env);
  const attempt = await store.getHostedMachineAttempt(account.id, "attempt-hopeless");
  assert.equal(attempt?.desiredState, "deleted", "abandoned rather than retried again");
  assert.equal(attempt?.state, "failed");
  assert.match(attempt?.lastError ?? "", /abandoned after 8 retries/);
  assert.equal(removedNode, "eph-hopeless", "the never-provisioned node is unenrolled, not left orphaned");
  assert.equal((await store.listHostedMachineAttempts(account.id, true)).some((a) => a.attemptId === "attempt-hopeless" && a.desiredState !== "deleted"), false);

  console.log("✓ an attempt past the retry ceiling is abandoned and its node unenrolled, not retried forever");
}

// --- Orphan discovery: a resource whose OWN attempt row was lost -----------
// The one failure mode idempotent-create/adopt can't cover — nothing tracks
// it at all, only discover() can.
{
  const store = createPgMemStore();
  await store.init();
  const account = await accountWithHostedToken(store, "orphan-found@example.com");
  // No hosted_machines entry, no attempt row: total tracking loss.
  const orphanMachine = { id: "orphan-1", provider: "hetzner", name: "bivy-orphan", region: "nbg1", status: "running", ip: null, createdAt: iso(30 * 60_000) };
  const discover: DiscoverFn = async () => [orphanMachine];
  let destroyed = 0;
  const destroy: DestroyFn = async (m) => { assert.equal(m.id, "orphan-1"); destroyed++; };
  const observe: ObserveFn = async () => "gone";

  const result = await sweepOrphanProviderResources(store, account.id, env, Date.now(), destroy, observe, discover);
  assert.deepEqual(result, { found: 1, reaped: 1, failed: 0 });
  assert.equal(destroyed, 1);
  const seeded = await store.getHostedMachineAttempt(account.id, "orphan-hetzner-orphan-1");
  assert.equal(seeded?.state, "deleted");
  assert.equal(seeded?.desiredState, "deleted");

  console.log("✓ orphan discovery finds, seeds, destroys, and confirms a resource with no prior tracking at all");
}

// --- Orphan discovery: skip a resource younger than the boot deadline ------
// A create in flight whose attempt-row write merely hasn't landed YET (not
// lost) must not be raced into a spurious delete.
{
  const store = createPgMemStore();
  await store.init();
  const account = await accountWithHostedToken(store, "orphan-too-young@example.com");
  const freshMachine = { id: "fresh-1", provider: "hetzner", name: "bivy-fresh", region: "nbg1", status: "starting", ip: null, createdAt: iso(60_000) };
  const discover: DiscoverFn = async () => [freshMachine];
  let destroyed = 0;
  const destroy: DestroyFn = async () => { destroyed++; };

  const result = await sweepOrphanProviderResources(store, account.id, env, Date.now(), destroy, undefined, discover);
  assert.deepEqual(result, { found: 0, reaped: 0, failed: 0 });
  assert.equal(destroyed, 0, "a resource younger than the boot deadline is left alone");
  assert.equal(await store.getHostedMachineAttempt(account.id, "orphan-hetzner-fresh-1"), undefined);

  console.log("✓ orphan discovery ignores a resource younger than the boot deadline");
}

// --- Orphan discovery: skip a resource that IS already tracked -------------
{
  const store = createPgMemStore();
  await store.init();
  const account = await accountWithHostedToken(store, "orphan-already-tracked@example.com");
  const tracked = { id: "tracked-1", provider: "hetzner", nodeId: "eph-tracked", createdAt: iso(30 * 60_000), ttlMinutes: 60 };
  await store.setHostedMachines(account.id, [tracked]);
  const discover: DiscoverFn = async () => [{ id: "tracked-1", provider: "hetzner", name: "bivy-tracked", region: "nbg1", status: "running", ip: null, createdAt: tracked.createdAt }];
  let destroyed = 0;
  const destroy: DestroyFn = async () => { destroyed++; };

  const result = await sweepOrphanProviderResources(store, account.id, env, Date.now(), destroy, undefined, discover);
  assert.deepEqual(result, { found: 0, reaped: 0, failed: 0 });
  assert.equal(destroyed, 0, "an already-tracked resource is never touched by the orphan sweep");

  console.log("✓ orphan discovery never re-acts on a resource the inventory already tracks");
}

// --- Orphan discovery: destroy failure is retained for retry, not dropped --
{
  const store = createPgMemStore();
  await store.init();
  const account = await accountWithHostedToken(store, "orphan-destroy-fails@example.com");
  const orphanMachine = { id: "orphan-2", provider: "hetzner", name: "bivy-orphan-2", region: "nbg1", status: "running", ip: null, createdAt: iso(30 * 60_000) };
  const discover: DiscoverFn = async () => [orphanMachine];
  const destroy: DestroyFn = async () => { throw new Error("provider unavailable"); };

  const result = await sweepOrphanProviderResources(store, account.id, env, Date.now(), destroy, undefined, discover);
  assert.deepEqual(result, { found: 1, reaped: 0, failed: 1 });
  const seeded = await store.getHostedMachineAttempt(account.id, "orphan-hetzner-orphan-2");
  assert.equal(seeded?.state, "deleting", "retained — a failed delete may still be billing, never silently dropped");
  assert.equal(seeded?.desiredState, "deleted");

  console.log("✓ a failed orphan destroy retains the seeded attempt for the next sweep to retry");
}

// --- Orphan discovery: re-running the sweep is idempotent -------------------
{
  const store = createPgMemStore();
  await store.init();
  const account = await accountWithHostedToken(store, "orphan-idempotent@example.com");
  const orphanMachine = { id: "orphan-3", provider: "hetzner", name: "bivy-orphan-3", region: "nbg1", status: "running", ip: null, createdAt: iso(30 * 60_000) };
  const discover: DiscoverFn = async () => [orphanMachine];
  const destroy: DestroyFn = async () => { throw new Error("still unavailable"); };

  await sweepOrphanProviderResources(store, account.id, env, Date.now(), destroy, undefined, discover);
  await sweepOrphanProviderResources(store, account.id, env, Date.now(), destroy, undefined, discover);
  const all = await store.listHostedMachineAttempts(account.id, true);
  assert.equal(all.filter((a) => a.attemptId === "orphan-hetzner-orphan-3").length, 1, "re-discovering the same untracked resource updates one row, not two");

  console.log("✓ re-running the orphan sweep on the same resource is idempotent, not duplicative");
}
