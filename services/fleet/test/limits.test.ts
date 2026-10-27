// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// The caps a deployment applies on its own, and what happens when an operator
// policy service is configured on top of them.
import { LocalAdmission, sizeClassesFrom, type FleetLimits } from "../src/limits.js";
import { composeAdmission, type Admission, type PolicyContext } from "../src/policy.js";
import { MemoryFleetStore } from "../src/store.js";
import { clock, expect, run } from "./harness.js";

const ACCOUNT = "acc-1";
const INTERACTIVE: PolicyContext = { computeSource: "managed", purpose: "interactive", sizeId: "shared-4x-8gb" };
const RUNNER: PolicyContext = { computeSource: "managed", purpose: "runner", sizeId: "shared-4x-8gb" };

function limits(overrides: Partial<FleetLimits> = {}): FleetLimits {
  return { maxMachines: 0, maxRunnersPerAccount: 3, monthlyHours: 0, sizeClasses: ["standard"], maxDiskGb: 100, includedDiskGb: 20, ...overrides };
}

async function unmeteredByDefault() {
  const store = new MemoryFleetStore();
  const admission = new LocalAdmission(store, limits());
  expect((await admission.admit(ACCOUNT, "r1", INTERACTIVE)).allowed, "a fleet with no caps admits every start");
  expect(await admission.secondsLeft(ACCOUNT) === undefined, "and reports no allowance to run out");
}

async function monthlyHoursRunOut() {
  const store = new MemoryFleetStore();
  const time = clock(Date.parse("2026-03-20T12:00:00.000Z"));
  const admission = new LocalAdmission(store, limits({ monthlyHours: 2 }), time.now);
  await store.settle(ACCOUNT, "run-1", "2026-03-19T00:00:00.000Z", 3600);
  expect(await admission.secondsLeft(ACCOUNT) === 3600, "an hour used this month leaves an hour");
  expect((await admission.admit(ACCOUNT, "r1", INTERACTIVE)).allowed, "which is enough to start");
  await store.settle(ACCOUNT, "run-2", "2026-03-19T12:00:00.000Z", 3600);
  const refused = await admission.admit(ACCOUNT, "r2", INTERACTIVE);
  expect(!refused.allowed && refused.code === "machine_time", "once the month's hours are gone, starts are refused");
  await store.settle(ACCOUNT, "run-0", "2026-02-15T00:00:00.000Z", 36_000);
  expect(await admission.secondsLeft(ACCOUNT) === 0, "last month's hours do not count against this month");
  time.advance(20 * 86_400_000);
  expect(await admission.secondsLeft(ACCOUNT) === 7200, "the allowance comes back with the new month");
}

async function runnerSlotsAndFleetSize() {
  const store = new MemoryFleetStore();
  const admission = new LocalAdmission(store, limits({ maxRunnersPerAccount: 1, maxMachines: 2 }));
  const runner = (runnerId: string, state: string) => store.putRunner({
    accountId: ACCOUNT, runnerId, app: "app", region: "iad", size: "shared-4x-8gb", state,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  });
  await runner("work:1", "awake");
  const busy = await admission.admit(ACCOUNT, "r1", RUNNER);
  expect(!busy.allowed && busy.code === "concurrent_runners" && busy.usage?.limit === 1, "an account cannot exceed its runner slots");
  await store.putRunner({ ...(await store.getRunner(ACCOUNT, "work:1"))!, state: "asleep" });
  expect((await admission.admit(ACCOUNT, "r2", RUNNER)).allowed, "a sleeping runner holds no slot");

  await runner("work:2", "asleep");
  await store.put({ accountId: ACCOUNT, nodeId: "n", app: "a", region: "iad", size: "shared-4x-8gb", state: "awake", awakeSeconds: 0, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" });
  const full = await admission.admit("acc-2", "r3", INTERACTIVE);
  expect(!full.allowed && full.code === "fleet_full", "a deployment-wide machine cap stops a runaway fleet");
}

async function runnersOffRefusesRunners() {
  const store = new MemoryFleetStore();
  const admission = new LocalAdmission(store, limits({ maxRunnersPerAccount: 0 }));
  const refused = await admission.admit(ACCOUNT, "r1", RUNNER);
  expect(!refused.allowed && refused.code === "runners_disabled", "a fleet that runs no runners says so");
  expect((await admission.admit(ACCOUNT, "r2", INTERACTIVE)).allowed, "its computers still start");
}

async function diskAndSizeClasses() {
  const store = new MemoryFleetStore();
  expect(await new LocalAdmission(store, limits()).diskAllowed(), "disk can grow when the maximum is above the included size");
  expect(!await new LocalAdmission(store, limits({ maxDiskGb: 20 })).diskAllowed(), "and cannot when they are the same");
  expect(sizeClassesFrom("standard, performance").join(",") === "standard,performance", "named size classes are read as a list");
  expect(sizeClassesFrom("standard huge standard").join(",") === "standard", "unknown and repeated names are dropped");
  expect(sizeClassesFrom(undefined).length === 0, "nothing named means none allowed beyond the default");
}

async function policyServiceAppliesOnTop() {
  const store = new MemoryFleetStore();
  const local = new LocalAdmission(store, limits({ monthlyHours: 10, sizeClasses: ["standard", "boost"] }));
  const generous: Admission = {
    admit: async () => ({ allowed: true }),
    secondsLeft: async () => 1_000_000,
    sizeClasses: async () => ["standard", "boost", "performance"],
    diskAllowed: async () => true,
  };
  const both = composeAdmission(local, generous);
  expect(await both.secondsLeft!(ACCOUNT) === 36_000, "a policy service cannot raise the deployment's own allowance");
  expect((await both.sizeClasses!(ACCOUNT)).join(",") === "standard,boost", "nor offer a size class the deployment withholds");

  const strict: Admission = { admit: async () => ({ allowed: false, code: "unpaid", reason: "no" }), secondsLeft: async () => 60, diskAllowed: async () => false };
  const tightened = composeAdmission(local, strict);
  const refused = await tightened.admit(ACCOUNT, "r1", INTERACTIVE);
  expect(!refused.allowed && refused.code === "unpaid", "but it can refuse an account the deployment would have admitted");
  expect(await tightened.secondsLeft!(ACCOUNT) === 60, "and lower its allowance");
  expect(!await tightened.diskAllowed!(ACCOUNT), "and withhold disk growth");
}

await run(
  unmeteredByDefault,
  monthlyHoursRunOut,
  runnerSlotsAndFleetSize,
  runnersOffRefusesRunners,
  diskAndSizeClasses,
  policyServiceAppliesOnTop,
);
