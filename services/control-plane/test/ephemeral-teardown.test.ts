// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { reapSettledHostedMachine, reconcileHostedMachines, type DestroyFn } from "../src/ephemeral-provisioner.js";
import type { MeshStore } from "../src/store.js";

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
  } as unknown as MeshStore;
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

console.log("ephemeral-teardown (control-plane): all tests passed");
