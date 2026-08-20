// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { createPgMemStore } from "../src/pg-mem-store.js";
import {
  COMPUTE_PLAN_CAPS,
  enforceManagedComputeLaunch,
  evaluateComputeCaps,
  summarizeAccountUsage,
  usageFromManagedMachine,
  usageSecondsWithin,
  utcMonthWindow,
} from "../src/compute-metering.js";

const machine = (overrides: Record<string, unknown> = {}) => ({
  id: "machine-1", nodeId: "node-1", attemptId: "attempt-1", provider: "fly", computeSource: "managed",
  createdAt: "2026-02-01T00:00:00.000Z",
  milestones: { requestedAt: "2026-01-31T23:59:50.000Z", firstAgentEventAt: "2026-02-01T00:00:20.000Z" },
  ...overrides,
});

const metered = usageFromManagedMachine("acct-1", machine(), "2026-02-01T00:01:20.000Z");
assert.ok(metered);
assert.equal(metered.machineSeconds, 80, "machine time starts at provider launch, not request");
assert.equal(metered.activeAgentSeconds, 60);

const neverActive = usageFromManagedMachine("acct-1", machine({ milestones: {} }), "2026-02-01T00:01:20.000Z");
assert.equal(neverActive?.machineSeconds, 80);
assert.equal(neverActive?.activeAgentSeconds, 0, "no first event means no estimated active-agent time");

const teardownFailed = usageFromManagedMachine("acct-1", machine(), "2026-02-01T00:02:00.000Z");
assert.equal(teardownFailed?.machineSeconds, 120, "settlement is metered even if provider teardown later fails");
assert.equal(teardownFailed?.activeAgentSeconds, 100);

const crossing = usageFromManagedMachine("acct-1", machine({
  createdAt: "2026-01-31T23:59:30.000Z",
  milestones: { firstAgentEventAt: "2026-01-31T23:59:50.000Z" },
}), "2026-02-01T00:00:30.000Z");
assert.ok(crossing);
const feb = utcMonthWindow(Date.parse("2026-02-15T12:00:00Z"));
assert.deepEqual(usageSecondsWithin(crossing, feb.startsAt, feb.endsAt), { machineSeconds: 30, activeAgentSeconds: 30 }, "month rollover apportions a crossing session");

for (const plan of ["individual", "pro", "team"] as const) {
  const caps = COMPUTE_PLAN_CAPS[plan];
  assert.deepEqual(evaluateComputeCaps(plan, {
    activeAgentSeconds: caps.monthlyActiveAgentSeconds - 1,
    concurrentManagedSessions: caps.maxConcurrentManagedSessions - 1,
  }, { ttlMinutes: caps.maxTtlMinutes }), { allowed: true }, `${plan} allows a request within every cap`);
}
assert.equal(evaluateComputeCaps("free", { activeAgentSeconds: 0, concurrentManagedSessions: 0 }, { ttlMinutes: 1 }).allowed, false);
assert.equal(evaluateComputeCaps("pro", { activeAgentSeconds: 0, concurrentManagedSessions: 4 }, { ttlMinutes: 60 }).allowed, false);
assert.equal(evaluateComputeCaps("team", { activeAgentSeconds: COMPUTE_PLAN_CAPS.team.monthlyActiveAgentSeconds, concurrentManagedSessions: 0 }, { ttlMinutes: 60 }).allowed, false);
const ttl = evaluateComputeCaps("individual", { activeAgentSeconds: 0, concurrentManagedSessions: 0 }, { ttlMinutes: 121 });
assert.equal(ttl.allowed, false);
if (!ttl.allowed) assert.equal(ttl.code, "session_ttl");

const summary = summarizeAccountUsage("individual", [crossing], 1, Date.parse("2026-02-15T12:00:00Z"), 10);
assert.deepEqual(summary.totals, { machineSeconds: 30, activeAgentSeconds: 30 });
assert.equal(summary.remaining.concurrentManagedSessions, 1);
assert.equal(summary.sessions[0]?.machineSeconds, 30);
const serialized = JSON.stringify(summary);
for (const forbidden of ["providerToken", "token-secret", "10.0.0.4", "nodeId", "provider"]) {
  assert.equal(serialized.includes(forbidden), false, `usage response redacts ${forbidden}`);
}

const audits: string[] = [];
const failingStore = {
  getAccount: async () => { throw new Error("database unavailable"); },
  listSessionUsage: async () => { throw new Error("database unavailable"); },
  getHostedMachines: async () => [],
  upsertSessionUsage: async (record: any) => record,
  appendHostedAudit: async (_accountId: string, event: { detail?: string }) => { audits.push(event.detail ?? ""); },
};
const failed = await enforceManagedComputeLaunch(failingStore, "acct-1", {
  id: "managed", name: "Managed", provider: "fly", computeSource: "managed", ttlMinutes: 60,
  createdAt: "2026-02-01T00:00:00Z", updatedAt: "2026-02-01T00:00:00Z",
});
assert.equal(failed.allowed, false, "meter store error fails closed");
if (!failed.allowed) assert.equal(failed.code, "metering_unavailable");
assert.deepEqual(audits, ["metering_unavailable"], "fail-closed denial is audited");

let byoReads = 0;
const byo = await enforceManagedComputeLaunch({
  ...failingStore,
  getAccount: async () => { byoReads++; throw new Error("must not read"); },
}, "acct-1", {
  id: "byo", name: "BYO", provider: "fly", ttlMinutes: 1440,
  createdAt: "2026-02-01T00:00:00Z", updatedAt: "2026-02-01T00:00:00Z",
});
assert.deepEqual(byo, { allowed: true });
assert.equal(byoReads, 0, "BYO launch is never metered or capped");

const store = createPgMemStore();
await store.init();
const account = await store.findOrCreateAccount("metering@example.com");
assert.equal(account.plan, "free");
await store.upsertSessionUsage({ ...crossing, accountId: account.id });
await store.upsertSessionUsage({ ...crossing, accountId: account.id, machineSeconds: 999 });
const persisted = await store.listSessionUsage(account.id, feb.startsAt, feb.endsAt);
assert.equal(persisted.length, 1, "settlement upsert is idempotent per machine/attempt");
assert.equal(persisted[0]?.machineSeconds, crossing.machineSeconds, "first settlement boundary wins across teardown retries");
assert.equal((await store.listSessionUsage(account.id, "2026-03-01T00:00:00Z", "2026-04-01T00:00:00Z")).length, 0, "new month excludes prior usage");

console.log("✓ compute accrual, store, month allocation, plan caps, redaction and fail-closed gate");
