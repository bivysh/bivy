// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { createPgMemStore } from "../src/pg-mem-store.js";
import { usageFromManagedMachine, usageSecondsWithin, utcMonthWindow } from "../src/compute-metering.js";

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
assert.equal(teardownFailed?.machineSeconds, 120, "settlement is recorded even if provider teardown later fails");
assert.equal(teardownFailed?.activeAgentSeconds, 100);

const crossing = usageFromManagedMachine("acct-1", machine({
  createdAt: "2026-01-31T23:59:30.000Z",
  milestones: { firstAgentEventAt: "2026-01-31T23:59:50.000Z" },
}), "2026-02-01T00:00:30.000Z");
assert.ok(crossing);
const feb = utcMonthWindow(Date.parse("2026-02-15T12:00:00Z"));
assert.deepEqual(usageSecondsWithin(crossing, feb.startsAt, feb.endsAt), { machineSeconds: 30, activeAgentSeconds: 30 });

const store = createPgMemStore();
await store.init();
const account = await store.findOrCreateAccount("metering@example.com");
await store.upsertSessionUsage({ ...crossing, accountId: account.id });
await store.upsertSessionUsage({ ...crossing, accountId: account.id, machineSeconds: 999 });
const persisted = await store.listSessionUsage(account.id, feb.startsAt, feb.endsAt);
assert.equal(persisted.length, 1, "settlement upsert is idempotent per machine/attempt");
assert.equal(persisted[0]?.machineSeconds, crossing.machineSeconds, "first settlement boundary wins across teardown retries");
assert.equal((await store.listSessionUsage(account.id, "2026-03-01T00:00:00Z", "2026-04-01T00:00:00Z")).length, 0);

console.log("✓ provider-neutral compute accrual, month allocation and idempotent storage");
