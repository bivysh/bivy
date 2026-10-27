// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
//
// The cloud-computer lifecycle: one machine per account, metered while awake,
// guarded while running, and deleted only after the account has been told.
import { CloudComputers, cloudComputerApp, type RunLedger } from "../src/computers.js";
import type { Admission } from "../src/policy.js";
import { MemoryFleetStore } from "../src/store.js";
import { clock, computeSettings, DAY_MS, expect, FakeCore, FakeProvider, run } from "./harness.js";

const ACCOUNT = "acc-1";

function fleet(options: {
  admission?: Partial<Admission>;
  settings?: Parameters<typeof computeSettings>[0];
  warnIdle?: boolean;
} = {}) {
  const store = new MemoryFleetStore();
  const provider = new FakeProvider();
  const core = new FakeCore();
  const time = clock();
  const runs: RunLedger = {
    settle: (accountId, runId, at, machineSeconds) => store.settle(accountId, runId, at, machineSeconds),
    fail: (accountId, runId, at) => store.fail(accountId, runId, at),
  };
  const admission: Admission = { admit: async () => ({ allowed: true }), ...options.admission };
  const computers = new CloudComputers({
    store, provider, core, runs, admission,
    settings: computeSettings(options.settings),
    ...(options.warnIdle === false ? {} : { warnIdle: (accountId, deleteAt) => core.notice(accountId, "computer", deleteAt).then(() => undefined) }),
    now: time.now,
  });
  return { store, provider, core, time, computers };
}

async function createsAndReuses() {
  const { store, provider, core, computers } = fleet();
  const first = await computers.acquire({ accountId: ACCOUNT, purpose: "interactive", requestId: "r1", sessionId: "s-old" });
  expect(first.allowed && first.state === "launching", "the first acquire launches a machine");
  expect(provider.apps.has(cloudComputerApp(ACCOUNT, "test")), "the account gets its own app, named for this fleet");
  expect(provider.machines.size === 1 && provider.volumes.size === 1, "one machine on one disk");
  expect(core.bootstraps[0]?.restoreSessionId === "s-old", "a new disk is booted with the session to restore");

  const again = await computers.acquire({ accountId: ACCOUNT, purpose: "interactive", requestId: "r2" });
  expect(again.allowed && again.state === "awake", "an awake machine is reused");
  expect(provider.machines.size === 1, "no second machine is created");
  expect((await store.get(ACCOUNT))?.nodeId === `eph-managed-auto-${ACCOUNT}`, "the record keeps the node id Core enrolled");
}

async function wakesWithTheCurrentImage() {
  const { provider, core, computers } = fleet();
  await computers.acquire({ accountId: ACCOUNT, purpose: "interactive", requestId: "r1" });
  const machine = provider.only();
  await provider.stopMachine(machine.app, machine.id);
  const woken = await computers.wake(ACCOUNT, `eph-managed-auto-${ACCOUNT}`, "app-open");
  expect(woken.state === "waking", "a stopped machine is woken");
  expect(provider.only().starts === 2, "the same machine is started again");
  expect(core.bootstraps.length === 1, "an unchanged image needs no new boot payload");
}

async function metersAwakeTime() {
  const { store, provider, time, computers } = fleet();
  await computers.acquire({ accountId: ACCOUNT, purpose: "interactive", requestId: "run-1" });
  time.advance(120_000);
  const machine = provider.only();
  await provider.stopMachine(machine.app, machine.id);
  await computers.reconcile();
  expect(await store.usedSeconds(ACCOUNT, "2026-01-01T00:00:00.000Z") === 120, "two awake minutes are metered as 120 Standard seconds");
  expect((await store.get(ACCOUNT))?.state === "asleep", "the machine is recorded asleep");
}

async function metersBiggerSizesHeavier() {
  const { store, provider, time, computers } = fleet({ admission: { sizeClasses: async () => ["boost"] } });
  await computers.setSize(ACCOUNT, "shared-8x-16gb");
  await computers.acquire({ accountId: ACCOUNT, purpose: "interactive", requestId: "run-1" });
  time.advance(60_000);
  await provider.stopMachine(provider.only().app, provider.only().id);
  await computers.reconcile();
  expect(await store.usedSeconds(ACCOUNT, "2026-01-01T00:00:00.000Z") === 120, "an hour on a 2x size uses two Standard hours");
}

async function earlyStartsAreFreeUntilUsed() {
  const { store, provider, time, computers } = fleet({ settings: { earlyStarts: true } });
  await computers.acquire({ accountId: ACCOUNT, purpose: "signup", requestId: "signup:1" });
  time.advance(31 * 60_000);
  const stopped = await computers.reconcile();
  expect(stopped.unused.length === 1, "an early start nobody used is stopped once its grace runs out");
  expect(await store.usedSeconds(ACCOUNT, "2026-01-01T00:00:00.000Z") === 0, "and is metered at nothing");

  const reconnect = await computers.wake(ACCOUNT, `eph-managed-auto-${ACCOUNT}`, "connect");
  expect(reconnect.state === "asleep", "a client reconnecting on its own does not restart a machine stopped unused");

  await computers.wake(ACCOUNT, `eph-managed-auto-${ACCOUNT}`, "app-visible");
  time.advance(60_000);
  await computers.used(ACCOUNT, `eph-managed-auto-${ACCOUNT}`, time.iso());
  time.advance(60_000);
  await provider.stopMachine(provider.only().app, provider.only().id);
  await computers.reconcile();
  expect(await store.usedSeconds(ACCOUNT, "2026-01-01T00:00:00.000Z") === 60, "a used early start is metered only from its first use");
}

async function stopsRunawayAndExhaustedMachines() {
  const guard = fleet();
  await guard.computers.acquire({ accountId: ACCOUNT, purpose: "interactive", requestId: "r1" });
  guard.provider.busy = [guard.provider.only().app];
  expect((await guard.computers.reconcile()).stopped.length === 1, "a machine pinning its CPUs is stopped");
  expect(guard.provider.only().state === "stopped", "and really stops");

  const spent = fleet({ admission: { secondsLeft: async () => 0 } });
  await spent.computers.acquire({ accountId: ACCOUNT, purpose: "interactive", requestId: "r1" });
  expect((await spent.computers.reconcile()).outOfAllowance.length === 1, "a machine out of allowance is stopped");

  const unreachable = fleet({ admission: { secondsLeft: async () => { throw new Error("policy down"); } } });
  await unreachable.computers.acquire({ accountId: ACCOUNT, purpose: "interactive", requestId: "r1" });
  const result = await unreachable.computers.reconcile();
  expect(result.outOfAllowance.length === 0 && result.stopped.length === 0, "an unreachable policy service never stops a running machine");
}

async function deletesOnlyAfterNotice() {
  const { store, provider, core, time, computers } = fleet();
  await computers.acquire({ accountId: ACCOUNT, purpose: "interactive", requestId: "r1" });
  await provider.stopMachine(provider.only().app, provider.only().id);
  time.advance(24 * DAY_MS);
  await computers.reconcile();
  expect(core.notices.length === 1, "the account is warned a week before deletion");
  // Past the 30 idle days, but the warning has only been out six of its seven.
  time.advance(6 * DAY_MS + DAY_MS / 2);
  await computers.reconcile();
  expect(provider.machines.size === 1, "deletion waits until the warning has been out its full notice period");
  time.advance(DAY_MS);
  await computers.reconcile();
  expect(provider.machines.size === 0 && provider.destroyedApps.length === 1, "then the machine, its disk and its app go");
  expect(core.retiredNodes.length === 1 && !(await store.get(ACCOUNT)), "Core is told, and the fleet forgets it");
}

async function adoptsMachinesWithTheSweepOff() {
  // Taking over a fleet whose records live somewhere else: the apps are there,
  // this store is empty, and nothing may be deleted until the records arrive.
  const { provider, time, computers } = fleet({ settings: { sweepOrphans: false } });
  await provider.ensureApp(cloudComputerApp("someone-else", "test"));
  time.advance(31 * 60_000);
  expect((await computers.reconcile()).swept.length === 0, "with the sweep off, an app no record owns is left alone however long it sits there");
  expect(provider.apps.size === 1, "and still exists, so its disk does too");
}

async function releaseAndOrphanSweep() {
  const { provider, core, time, computers } = fleet();
  await computers.acquire({ accountId: ACCOUNT, purpose: "interactive", requestId: "r1" });
  expect(await computers.release(ACCOUNT, `eph-managed-auto-${ACCOUNT}`), "release destroys the machine on request");
  expect(provider.machines.size === 0 && core.retiredNodes.length === 1, "nothing is left behind");

  await provider.ensureApp(`${cloudComputerApp("other", "test")}`);
  expect((await computers.reconcile()).swept.length === 0, "an app seen for the first time is left alone");
  time.advance(31 * 60_000);
  expect((await computers.reconcile()).swept.length === 1, "an app no record owns is swept once it has looked orphaned for a while");
}

async function diskGrowsOnlyWhenAllowed() {
  const closed = fleet();
  await closed.computers.acquire({ accountId: ACCOUNT, purpose: "interactive", requestId: "r1" });
  const refused = await closed.computers.growDisk(ACCOUNT, 30);
  expect(!refused.ok && refused.code === "not_allowed", "a disk does not grow unless the deployment allows it");

  const open = fleet({ admission: { diskAllowed: async () => true } });
  await open.computers.acquire({ accountId: ACCOUNT, purpose: "interactive", requestId: "r1" });
  const odd = await open.computers.growDisk(ACCOUNT, 27);
  expect(!odd.ok && odd.code === "invalid_size", "it grows in whole steps only");
  const grown = await open.computers.growDisk(ACCOUNT, 30);
  expect(grown.ok && grown.sizeGb === 30, "an allowed step grows the disk");
  expect([...open.provider.volumes.values()][0]?.sizeGb === 30, "the provider volume really grew");
  const view = await open.computers.disk(ACCOUNT);
  expect(view?.sizeGb === 30 && view.canGrow, "the view reports the new size and that more is available");
}

async function sizePreferenceFallsBack() {
  const { computers } = fleet({ admission: { sizeClasses: async () => [] } });
  const refused = await computers.setSize(ACCOUNT, "performance-4x-8gb");
  expect(!refused.ok && refused.code === "not_allowed", "a size the deployment does not allow is refused");
  expect(await computers.sizeFor(ACCOUNT) === "shared-4x-8gb", "so the default size runs");
  const unknown = await computers.setSize(ACCOUNT, "nope");
  expect(!unknown.ok && unknown.code === "unknown_size", "an unknown size is rejected outright");
}

async function refusalIsPassedOn() {
  const { provider, computers } = fleet({ admission: { admit: async () => ({ allowed: false, code: "machine_time", reason: "no hours left" }) } });
  const result = await computers.acquire({ accountId: ACCOUNT, purpose: "interactive", requestId: "r1" });
  expect(!result.allowed && result.decision.code === "machine_time", "a refusal comes back as the decision that caused it");
  expect(provider.machines.size === 0, "and nothing is launched");
}

async function oneMachinePerAccountUnderLoad() {
  const { provider, computers } = fleet();
  const [a, b] = await Promise.all([
    computers.acquire({ accountId: ACCOUNT, purpose: "interactive", requestId: "r1" }),
    computers.acquire({ accountId: ACCOUNT, purpose: "interactive", requestId: "r2" }),
  ]);
  expect(a.allowed && b.allowed, "two simultaneous requests both succeed");
  expect(provider.machines.size === 1, "but only one machine is ever created");
}

await run(
  createsAndReuses,
  wakesWithTheCurrentImage,
  metersAwakeTime,
  metersBiggerSizesHeavier,
  earlyStartsAreFreeUntilUsed,
  stopsRunawayAndExhaustedMachines,
  deletesOnlyAfterNotice,
  releaseAndOrphanSweep,
  adoptsMachinesWithTheSweepOff,
  diskGrowsOnlyWhenAllowed,
  sizePreferenceFallsBack,
  refusalIsPassedOn,
  oneMachinePerAccountUnderLoad,
);
