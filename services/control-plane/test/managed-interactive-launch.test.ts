// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import test from "node:test";
import { createPgMemStore } from "../src/pg-mem-store.js";
import { managedInteractiveLaunch, managedRequestId, ManagedLaunchConflict, type ManagedInteractiveRequest } from "../src/managed-interactive-launch.js";
import { managedCapacityCount, activeManagedMachineCount, managedConcurrencyLimit } from "../src/managed-admission.js";
import { reconcileHostedMachines, provisionEphemeralForAccount } from "../src/ephemeral-provisioner.js";
import type { launchEphemeralMachine } from "@bivy/core";
import type { EphemeralMachine } from "@bivy/core";

async function fixture() {
  const store = createPgMemStore(); await store.init();
  const account = await store.findOrCreateAccount("interactive@example.test");
  const request: ManagedInteractiveRequest = { requestId: "first-prompt", purpose: "interactive", config: {
    id: "managed-default", name: "Cloud", provider: "fly", computeSource: "managed", region: "iad", size: "shared-2x-4gb", ttlMinutes: 5,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  } };
  let creates = 0, admits = 0;
  const effects = {
    limit: 1,
    admit: async () => { admits++; },
    launch: async (attemptId: string, nodeId: string): Promise<EphemeralMachine> => {
      creates++;
      const machine: EphemeralMachine = { id: `machine-${creates}`, attemptId, nodeId, provider: "fly", computeSource: "managed", purpose: request.purpose, region: "iad", name: "test", status: "running", ip: null, createdAt: new Date().toISOString() };
      await store.setHostedMachines(account.id, [...await store.getHostedMachines(account.id), { ...machine }]);
      return machine;
    },
  };
  const launch = (input = request, overrides: Partial<typeof effects> = {}) => managedInteractiveLaunch(store, account.id, input, { ...effects, ...overrides });
  return { store, account, request, effects, launch, counts: () => ({ creates, admits }) };
}
const code = (wanted: string) => (error: unknown) => error instanceof ManagedLaunchConflict && error.code === wanted;

test("lost HTTP response replays the same durable receipt without admission or another purchase", async () => {
  const f = await fixture();
  const first = await f.launch();
  const replay = await f.launch();
  assert.equal(first.machine.id, replay.machine.id);
  assert.equal(replay.duplicate, true);
  assert.deepEqual(f.counts(), { creates: 1, admits: 1 });
  assert.equal(managedCapacityCount(await f.store.getHostedMachines(f.account.id), await f.store.listHostedMachineAttempts(f.account.id)), 1);
  await assert.rejects(f.launch({ ...f.request, runtimeId: "other-agent" }), code("managed_request_conflict"));
  await assert.rejects(f.launch({ ...f.request, config: { ...f.request.config, id: "other-profile" } }), code("managed_request_conflict"));
});

test("concurrent callers share the queue's account lease and cannot oversubscribe", async () => {
  const f = await fixture();
  let entered!: () => void, release!: () => void;
  const enteredPromise = new Promise<void>((r) => { entered = r; });
  const gate = new Promise<void>((r) => { release = r; });
  const first = f.launch(f.request, { admit: async () => { entered(); await gate; } });
  await enteredPromise;
  assert.equal(await f.store.acquireHostedProvisionLease(f.account.id, "queue-worker", 300), false);
  await assert.rejects(f.launch({ ...f.request, requestId: "second-prompt" }), code("managed_launch_busy"));
  release(); await first;
  await assert.rejects(f.launch({ ...f.request, requestId: "second-prompt" }), code("managed_concurrency_limit"));
  assert.equal(f.counts().creates, 1);
});

test("reconciliation cannot retry a reserved attempt while the original provider call owns the lease", async () => {
  const f = await fixture();
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>((r) => { entered = r; });
  const gate = new Promise<void>((r) => { release = r; });
  const first = f.launch(f.request, { launch: async (...args) => { entered(); await gate; return f.effects.launch(...args); } });
  await ready;
  await reconcileHostedMachines(f.store, f.account.id, Date.now() + 120_000, { cpBaseUrl: "https://unused.invalid", relayUrl: "wss://unused.invalid" });
  const [attempt] = await f.store.listHostedMachineAttempts(f.account.id);
  assert.equal(attempt.retryCount, 0);
  assert.equal(attempt.state, "requested");
  release(); await first;
  assert.equal(f.counts().creates, 1);
});

test("receipt fingerprint survives the real provisioner's lifecycle writes and key escrow", async () => {
  const oldToken = process.env.MANAGED_PROVIDER_TOKEN_FLY;
  const oldKey = process.env.HOSTED_CREDENTIAL_KEY;
  process.env.MANAGED_PROVIDER_TOKEN_FLY = "test-only";
  process.env.HOSTED_CREDENTIAL_KEY = Buffer.alloc(32, 7).toString("base64");
  try {
    const f = await fixture();
    const launcher: typeof launchEphemeralMachine = async (opts, deps) => {
      const nodeId = opts.reuseNodeId!;
      const attemptId = opts.attemptId!;
      await opts.onLifecycle?.({ nodeId, attemptId, phase: "requested" });
      const key = Buffer.alloc(32, 9).toString("base64");
      deps.store.addKey(nodeId, key);
      await deps.persistRoomKey!(nodeId, key);
      const machine: EphemeralMachine = { id: "real-lifecycle", nodeId, attemptId, provider: "fly", name: "test", region: "iad", status: "running", ip: null, createdAt: new Date().toISOString() };
      await opts.onLifecycle?.({ nodeId, attemptId, phase: "provider-accepted", machine });
      await deps.machines.add(machine);
      return machine;
    };
    await f.launch(f.request, { launch: (attemptId, nodeId) => provisionEphemeralForAccount(f.store, f.account.id, f.request.config, { cpBaseUrl: "https://unused.invalid", relayUrl: "wss://unused.invalid" }, launcher, Date.now(), "interactive", { attemptId, nodeId, retryCount: 0 }) });
    const replay = await f.launch();
    assert.equal(replay.duplicate, true);
    assert.equal(replay.machine.id, "real-lifecycle");
    assert.ok(await f.store.getNodeRoomKeyEnc(f.account.id, replay.machine.nodeId!));
    assert.equal(f.counts().creates, 0, "replay must never invoke a replacement launcher");
  } finally {
    if (oldToken === undefined) delete process.env.MANAGED_PROVIDER_TOKEN_FLY; else process.env.MANAGED_PROVIDER_TOKEN_FLY = oldToken;
    if (oldKey === undefined) delete process.env.HOSTED_CREDENTIAL_KEY; else process.env.HOSTED_CREDENTIAL_KEY = oldKey;
  }
});

test("unknown provider result remains a capacity reservation and cannot be repurchased", async () => {
  const f = await fixture();
  await assert.rejects(f.launch(f.request, { launch: async () => { throw new Error("response lost"); } }), /response lost/);
  const attempts = await f.store.listHostedMachineAttempts(f.account.id);
  assert.equal(attempts.length, 1);
  assert.equal(managedCapacityCount([], attempts), 1);
  await assert.rejects(f.launch(), code("managed_launch_pending"));
  await assert.rejects(f.launch({ ...f.request, requestId: "replacement" }), code("managed_concurrency_limit"));
  assert.equal(f.counts().creates, 0);
});

test("renewal failure after admission prevents enrollment and provider creation", async () => {
  const f = await fixture();
  f.store.renewHostedProvisionLease = async () => { throw new Error("database unavailable"); };
  await assert.rejects(f.launch(), code("managed_launch_busy"));
  assert.equal(f.counts().creates, 0);
  assert.equal((await f.store.listHostedMachineAttempts(f.account.id)).length, 0);
});

test("reservation persistence failure prevents a provider effect", async () => {
  const f = await fixture();
  f.store.putHostedMachineAttempt = async () => { throw new Error("disk full"); };
  await assert.rejects(f.launch(), /disk full/);
  assert.equal(f.counts().creates, 0);
});

test("inventory failure fails closed without policy admission", async () => {
  const f = await fixture();
  f.store.getHostedMachines = async () => { throw new Error("inventory unavailable"); };
  await assert.rejects(f.launch(), /inventory unavailable/);
  assert.deepEqual(f.counts(), { admits: 0, creates: 0 });
});

test("concurrent restore identities cannot allocate the same node twice", async () => {
  const f = await fixture();
  const request = { ...f.request, restore: { nodeId: "eph-original", sessionId: "session-1" } };
  const first = await f.launch(request, { limit: 3 });
  assert.equal(first.machine.nodeId, request.restore.nodeId);
  await assert.rejects(f.launch({ ...request, requestId: "other-device" }, { limit: 3 }), code("managed_restore_active"));
  assert.equal((await f.launch(request)).machine.id, first.machine.id);
  assert.equal(f.counts().creates, 1);
});

test("deleted request receipts cannot silently become new purchases", async () => {
  const f = await fixture();
  await f.launch();
  const [attempt] = await f.store.listHostedMachineAttempts(f.account.id);
  await f.store.putHostedMachineAttempt({ ...attempt, state: "deleted", desiredState: "deleted" });
  await f.store.setHostedMachines(f.account.id, []);
  await assert.rejects(f.launch(), code("managed_request_finished"));
  await f.launch({ ...f.request, requestId: "new-prompt" });
  assert.equal(f.counts().creates, 2);
});

test("authentication setup is a singleton even with independent request IDs", async () => {
  const f = await fixture();
  f.request.purpose = "auth-runner";
  const first = await f.launch();
  const second = await f.launch({ ...f.request, requestId: "another-device" }, { limit: 3 });
  assert.equal(second.machine.id, first.machine.id);
  assert.equal(second.duplicate, true);
  assert.equal(f.counts().creates, 1);
});

test("reservation/receipt keys are account-scoped", async () => {
  const f = await fixture();
  const first = await f.launch();
  const other = await f.store.findOrCreateAccount("other@example.test");
  const second = await managedInteractiveLaunch(f.store, other.id, f.request, { admit: async () => {}, launch: async (attemptId, nodeId) => ({ ...first.machine, attemptId, nodeId, id: "other-machine" }) });
  assert.notEqual(second.machine.nodeId, first.machine.nodeId);
  assert.equal(second.duplicate, false);
});

test("request IDs reject ambiguous or unbounded input", () => {
  for (const value of [null, 42, {}, "", " ", "x".repeat(201), "path/segment"]) assert.throws(() => managedRequestId(value), code("invalid_request_id"));
  assert.equal(managedRequestId("restore:s1:eph-1:m1"), "restore:s1:eph-1:m1");
});

// --- merged from managed-admission.test.ts ---
{
  const now = Date.parse("2026-08-25T12:00:00.000Z");

  test("managed concurrency retains overdue and failed resources until deletion is confirmed", () => {
    assert.equal(activeManagedMachineCount([
      { computeSource: "managed", status: "running", createdAt: "2026-08-25T11:30:00.000Z", ttlMinutes: 60 },
      { computeSource: "managed", status: "destroyed", createdAt: "2026-08-25T11:30:00.000Z", ttlMinutes: 60 },
      { computeSource: "managed", status: "running", createdAt: "2026-08-25T09:00:00.000Z", ttlMinutes: 60 },
      { computeSource: "user", status: "running", createdAt: "2026-08-25T11:30:00.000Z", ttlMinutes: 60 },
      { computeSource: "managed", status: "provisioning" },
      { computeSource: "managed", status: "failed" },
      { computeSource: "managed", status: "stopped" },
      { computeSource: "managed", status: "gone" },
    ], now), 5);
  });

  test("managed concurrency limit accepts only positive integers", () => {
    assert.equal(managedConcurrencyLimit("3"), 3);
    assert.equal(managedConcurrencyLimit("0"), undefined);
    assert.equal(managedConcurrencyLimit("1.5"), undefined);
    assert.equal(managedConcurrencyLimit("nope"), undefined);
  });
}
