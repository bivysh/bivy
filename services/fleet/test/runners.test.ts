// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Runners: a machine per piece of work, deleted when the work is done — except
// a session's runner, which sleeps and is deleted only after notice.
import type { RunLedger } from "../src/computers.js";
import type { Admission } from "../src/policy.js";
import { Runners, runnerApp } from "../src/runners.js";
import { MemoryFleetStore } from "../src/store.js";
import { clock, DAY_MS, expect, FakeCore, FakeProvider, run, runnerSettings } from "./harness.js";

const ACCOUNT = "acc-1";

function fleet(options: { admission?: Partial<Admission>; settings?: Parameters<typeof runnerSettings>[0] } = {}) {
  const store = new MemoryFleetStore();
  const provider = new FakeProvider();
  const core = new FakeCore();
  const time = clock();
  const runs: RunLedger = {
    settle: (accountId, runId, at, machineSeconds) => store.settle(accountId, runId, at, machineSeconds),
    fail: (accountId, runId, at) => store.fail(accountId, runId, at),
  };
  const runners = new Runners({
    store, provider, core, runs,
    admission: { admit: async () => ({ allowed: true }), ...options.admission },
    settings: runnerSettings(options.settings),
    sizeFor: async () => "shared-4x-8gb",
    warnSleeping: (accountId, deleteAt) => core.notice(accountId, "runner", deleteAt).then(() => undefined),
    now: time.now,
  });
  return { store, provider, core, time, runners };
}

async function launchesOnePerPieceOfWork() {
  const { provider, core, runners } = fleet();
  const first = await runners.launch({ accountId: ACCOUNT, runnerId: "work:1", requestId: "r1", sessionId: "s-1" });
  expect(first.allowed && first.state === "launching", "work gets a runner of its own");
  expect(provider.apps.has(runnerApp(ACCOUNT, "test")), "runners share an app apart from the computer's");
  expect(core.runnerBootstraps[0]?.restoreSessionId === "s-1", "the runner boots with the session to continue");

  const again = await runners.launch({ accountId: ACCOUNT, runnerId: "work:1", requestId: "r2" });
  expect(again.allowed && again.state === "awake", "asking twice reuses the running one");
  expect(provider.machines.size === 1, "and creates no second machine");

  await runners.launch({ accountId: ACCOUNT, runnerId: "work:2", requestId: "r3" });
  expect(provider.machines.size === 2 && provider.volumes.size === 2, "other work runs beside it, on its own disk");
}

async function disposesFinishedRunners() {
  const { store, provider, core, time, runners } = fleet();
  await runners.launch({ accountId: ACCOUNT, runnerId: "work:1", requestId: "r1" });
  time.advance(90_000);
  await provider.stopMachine(runnerApp(ACCOUNT, "test"), provider.only().id);
  const result = await runners.reconcile();
  expect(result.disposed === 1 && provider.machines.size === 0 && provider.volumes.size === 0, "a stopped runner and its disk are deleted");
  expect(await store.usedSeconds(ACCOUNT, "2026-01-01T00:00:00.000Z") === 90, "its awake time is metered first");
  expect(core.retiredNodes.length === 1, "and Core is told the node is gone");
}

async function sessionRunnersSleepAndWake() {
  const { store, provider, time, runners } = fleet();
  await runners.launch({ accountId: ACCOUNT, runnerId: "session:1", requestId: "r1", sleeps: true });
  const machine = provider.only();
  time.advance(60_000);
  await provider.stopMachine(machine.app, machine.id);
  await runners.reconcile();
  expect(provider.machines.size === 1, "a session's runner keeps its machine and disk when it stops");
  expect((await store.getRunner(ACCOUNT, "session:1"))?.state === "asleep", "it is recorded asleep");
  expect(await store.usedSeconds(ACCOUNT, "2026-01-01T00:00:00.000Z") === 60, "its awake period is metered and its slot freed");

  const woken = await runners.launch({ accountId: ACCOUNT, runnerId: "session:1", requestId: "r2" });
  expect(woken.allowed && provider.only().starts === 2, "coming back to the session starts the same runner");
}

async function sleepingRunnersAreDeletedAfterNotice() {
  const { provider, core, time, runners } = fleet();
  await runners.launch({ accountId: ACCOUNT, runnerId: "session:1", requestId: "r1", sleeps: true });
  await provider.stopMachine(runnerApp(ACCOUNT, "test"), provider.only().id);
  await runners.reconcile();
  time.advance(5 * DAY_MS + DAY_MS / 2);
  await runners.reconcile();
  expect(core.notices.length === 1 && core.notices[0]!.kind === "runner", "the account is warned before a sleeping runner goes");
  await runners.reconcile();
  expect(core.notices.length === 1, "and warned only once");
  time.advance(DAY_MS + DAY_MS / 2);
  await runners.reconcile();
  expect(provider.machines.size === 1, "deletion waits out the notice period");
  time.advance(DAY_MS);
  await runners.reconcile();
  expect(provider.machines.size === 0 && provider.volumes.size === 0, "then the runner and its disk go");
}

async function stopsRunnersPastTheirCap() {
  const { time, runners } = fleet();
  await runners.launch({ accountId: ACCOUNT, runnerId: "work:1", requestId: "r1" });
  time.advance(186 * 60_000);
  expect((await runners.reconcile()).stopped.length === 1, "a runner still awake past its cap is stopped");

  const spent = fleet({ admission: { secondsLeft: async () => 0 } });
  await spent.runners.launch({ accountId: ACCOUNT, runnerId: "work:1", requestId: "r1" });
  expect((await spent.runners.reconcile()).stopped.length === 1, "so is one whose account is out of allowance");
}

async function abandonsLaunchesThatNeverGotAMachine() {
  const { store, provider, time, runners } = fleet();
  provider.failOnce.add("createMachine");
  await runners.launch({ accountId: ACCOUNT, runnerId: "work:1", requestId: "r1" }).catch(() => undefined);
  expect(!(await store.getRunner(ACCOUNT, "work:1")), "a launch that failed part-way is cleaned up at once");
  expect(provider.volumes.size === 0, "including the disk it had already made");
  time.advance(11 * 60_000);
  expect((await runners.reconcile()).checked === 0, "nothing is left for reconcile to find");
}

async function refusalIsPassedOn() {
  const { provider, runners } = fleet({ admission: { admit: async () => ({ allowed: false, code: "concurrent_runners", reason: "busy" }) } });
  const result = await runners.launch({ accountId: ACCOUNT, runnerId: "work:1", requestId: "r1" });
  expect(!result.allowed && result.decision.code === "concurrent_runners", "a refusal comes back as the decision that caused it");
  expect(provider.machines.size === 0, "and nothing is launched");
}

async function releaseDeletesNow() {
  const { provider, core, runners } = fleet();
  const launched = await runners.launch({ accountId: ACCOUNT, runnerId: "work:1", requestId: "r1" });
  expect(launched.allowed && await runners.release(ACCOUNT, launched.nodeId), "Core can release a runner the moment the work is done");
  expect(provider.machines.size === 0 && core.retiredNodes.length === 1, "its machine and disk go immediately");
}

await run(
  launchesOnePerPieceOfWork,
  disposesFinishedRunners,
  sessionRunnersSleepAndWake,
  sleepingRunnersAreDeletedAfterNotice,
  stopsRunnersPastTheirCap,
  abandonsLaunchesThatNeverGotAMachine,
  refusalIsPassedOn,
  releaseDeletesNow,
);
