// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { reapSettledHostedMachine, reconcileHostedMachines, reconcileAllHostedMachines, markHostedMachineMilestone, type DestroyFn, type EphemeralProvisioningPort } from "../src/ephemeral-provisioner.js";

function fakeStore(machines: Array<Record<string, unknown>>, providerTokens: Record<string, string>) {
  let hosted = machines.slice();
  const audits: Array<Record<string, unknown>> = [];
  const store = {
    getHostedMachines: async () => hosted,
    setHostedMachines: async (_a: string, list: Array<Record<string, unknown>>) => { hosted = list; return list; },
    getHostedProvisioning: async () => ({ enabled: true, providerTokens }),
    createSession: async () => "sess-token",
    removeNode: async () => true,
    appendHostedAudit: async (_a: string, e: Record<string, unknown>) => { audits.push(e); },
  } as unknown as EphemeralProvisioningPort;
  return { store, audits };
}

const env = { cpBaseUrl: "https://cp", relayUrl: "wss://relay" };
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

// A settled hosted machine is destroyed at its provider, with the account's
// hosted token — the key path for Hetzner (halts but keeps billing on exit).
{
  const { store } = fakeStore(
    [{ id: "srv1", provider: "hetzner", nodeId: "eph-1", createdAt: iso(0), ttlMinutes: 60 }],
    { hetzner: "hz-token" },
  );
  const seen: Array<{ id: unknown; token: string | null }> = [];
  const fakeDestroy: DestroyFn = async (machine, deps) => { seen.push({ id: machine.id, token: await deps.keys.getToken("hetzner") }); };
  const found = await reapSettledHostedMachine(store, "acct", "eph-1", env, Date.now(), fakeDestroy);
  assert.equal(found, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].id, "srv1");
  assert.equal(seen[0].token, "hz-token");
}

// An untracked node (device-launched machine) → no-op, false, no destroy.
{
  const { store } = fakeStore([], {});
  let called = 0;
  const found = await reapSettledHostedMachine(store, "acct", "eph-x", env, Date.now(), async () => { called++; });
  assert.equal(found, false);
  assert.equal(called, 0);
}

// A settled machine without a provider credential remains tracked; neither the
// settled callback nor manual teardown may turn missing auth into false absence.
{
  const old = { id: "srv-no-token", provider: "hetzner", nodeId: "eph-no-token", createdAt: iso(0), ttlMinutes: 60 };
  const { store, audits } = fakeStore([old], {});
  const found = await reapSettledHostedMachine(store, "acct", "eph-no-token", env);
  assert.equal(found, true);
  assert.deepEqual(await store.getHostedMachines("acct"), [old]);
  assert.ok(audits.some((event) => event.action === "reconcile_failed"));
}

// Reconcile actively destroys a machine past its TTL grace when env + token given.
{
  const { store } = fakeStore(
    [{ id: "srv2", provider: "hetzner", nodeId: "eph-2", createdAt: iso(200 * 60_000), ttlMinutes: 60 }],
    { hetzner: "hz-token" },
  );
  let destroyed = 0;
  const n = await reconcileHostedMachines(store, "acct", Date.now(), env, async () => { destroyed++; });
  assert.equal(n, 1);
  assert.equal(destroyed, 1);
}

// A tracked attempt is actively observed and a runner that never joins is
// deleted at the boot deadline rather than burning its full TTL.
{
  const old = { id: "boot-stuck", provider: "fly", nodeId: "eph-stuck", attemptId: "attempt-stuck", createdAt: iso(20 * 60_000), ttlMinutes: 60, status: "starting" };
  const { store } = fakeStore([old], { fly: "fly-token" });
  const attempt = { accountId: "acct", attemptId: "attempt-stuck", provider: "fly", nodeId: "eph-stuck", state: "tracked", desired: {}, machine: old, retryCount: 0, createdAt: old.createdAt, updatedAt: old.createdAt } as const;
  Object.assign(store, {
    listHostedMachineAttempts: async () => [attempt],
    getHostedMachineAttempt: async () => attempt,
    putHostedMachineAttempt: async (next: unknown) => next,
    getEphemeralConfigs: async () => [],
  });
  // Two observe calls now: the pre-destroy check (still "starting", which is
  // what triggers the boot-deadline destroy) and the post-destroy confirmed-
  // deletion check (returns "gone", so the attempt/machine actually finalize).
  let observed = 0;
  let destroyed = 0;
  const observeFn = async () => { observed++; return observed === 1 ? "starting" : "gone"; };
  const n = await reconcileHostedMachines(store, "acct", Date.now(), env, async () => { destroyed++; }, observeFn);
  assert.equal(n, 1);
  assert.equal(observed, 2);
  assert.equal(destroyed, 1);
}

// Without env, reconcile is bookkeeping-only (no active destroy) — back-compat.
{
  const { store } = fakeStore(
    [{ id: "srv3", provider: "hetzner", nodeId: "eph-3", createdAt: iso(200 * 60_000), ttlMinutes: 60 }],
    { hetzner: "hz-token" },
  );
  let destroyed = 0;
  const n = await reconcileHostedMachines(store, "acct", Date.now(), undefined, async () => { destroyed++; });
  assert.equal(n, 1);
  assert.equal(destroyed, 0);
}

// A machine still within its TTL grace is kept, not reaped.
{
  const { store } = fakeStore(
    [{ id: "srv4", provider: "hetzner", nodeId: "eph-4", createdAt: iso(5 * 60_000), ttlMinutes: 60 }],
    { hetzner: "hz-token" },
  );
  let destroyed = 0;
  const n = await reconcileHostedMachines(store, "acct", Date.now(), env, async () => { destroyed++; });
  assert.equal(n, 0);
  assert.equal(destroyed, 0);
}

// Fleet reconciliation scans accounts without requiring a new enqueue. One
// broken account is audited and does not prevent another account being reaped.
{
  const old = { id: "srv5", provider: "hetzner", nodeId: "eph-5", createdAt: iso(200 * 60_000), ttlMinutes: 60 };
  const audits: Array<{ accountId: string; action?: string }> = [];
  const byAccount = new Map<string, Array<Record<string, unknown>>>([["good", [old]]]);
  const store = {
    listHostedMachineAccountIds: async () => ["broken", "good"],
    getHostedMachines: async (accountId: string) => {
      if (accountId === "broken") throw new Error("database row unavailable");
      return byAccount.get(accountId) ?? [];
    },
    setHostedMachines: async (accountId: string, list: Array<Record<string, unknown>>) => { byAccount.set(accountId, list); return list; },
    getHostedProvisioning: async () => ({ enabled: true, providerTokens: { hetzner: "hz-token" } }),
    createSession: async () => "sess-token",
    removeNode: async () => true,
    appendHostedAudit: async (accountId: string, event: { action?: string }) => { audits.push({ accountId, action: event.action }); },
  } as unknown as EphemeralProvisioningPort;
  let destroyed = 0;
  const result = await reconcileAllHostedMachines(store, env, Date.now(), async () => { destroyed++; });
  assert.deepEqual(result, { accounts: 2, reaped: 1, failed: 1 });
  assert.equal(destroyed, 1);
  assert.ok(audits.some((event) => event.accountId === "broken" && event.action === "reconcile_failed"));
}

// A provider DELETE failure must keep the resource tracked for the next sweep;
// otherwise a still-billing VM becomes an invisible orphan.
{
  const old = { id: "srv6", provider: "hetzner", nodeId: "eph-6", createdAt: iso(200 * 60_000), ttlMinutes: 60 };
  const { store, audits } = fakeStore([old], { hetzner: "hz-token" });
  const n = await reconcileHostedMachines(store, "acct", Date.now(), env, async () => { throw new Error("provider unavailable"); });
  assert.equal(n, 0);
  assert.deepEqual(await store.getHostedMachines("acct"), [old]);
  assert.ok(audits.some((event) => event.action === "reconcile_failed"));
}

// Missing credentials are not proof of deletion. Keep tracking the machine so
// rotating/re-adding the token lets a later sweep destroy it.
{
  const old = { id: "srv7", provider: "hetzner", nodeId: "eph-7", createdAt: iso(200 * 60_000), ttlMinutes: 60 };
  const { store, audits } = fakeStore([old], {});
  const n = await reconcileHostedMachines(store, "acct", Date.now(), env);
  assert.equal(n, 0);
  assert.deepEqual(await store.getHostedMachines("acct"), [old]);
  assert.ok(audits.some((event) => event.action === "reconcile_failed"));
}

// Cold-start milestones are server-stamped and first-write-wins.
{
  const { store, audits } = fakeStore([{ id: "srv8", provider: "fly", nodeId: "eph-8", createdAt: iso(0), milestones: { requestedAt: "2026-08-12T00:00:00.000Z" } }], {});
  assert.equal(await markHostedMachineMilestone(store, "acct", "eph-8", "nodeReadyAt", "2026-08-12T00:00:02.000Z"), true);
  assert.equal(await markHostedMachineMilestone(store, "acct", "eph-8", "nodeReadyAt", "2026-08-12T00:00:09.000Z"), true);
  const machine = (await store.getHostedMachines("acct"))[0];
  assert.deepEqual(machine.milestones, { requestedAt: "2026-08-12T00:00:00.000Z", nodeReadyAt: "2026-08-12T00:00:02.000Z" });
  assert.ok(audits.some((event) => event.action === "machine_milestone" && event.detail === "nodeReadyAt elapsedMs=2000"));
  assert.equal(await markHostedMachineMilestone(store, "acct", "eph-missing", "nodeReadyAt"), false);
}

console.log("ephemeral-teardown (control-plane): all tests passed");
