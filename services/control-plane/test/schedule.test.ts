// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { createPgMemStore } from "../src/pg-mem-store.js";
import { nextOccurrence, normalizeSchedule, processDueSchedules } from "../src/schedule.js";

function cron(expression: string, timezone: string) {
  return normalizeSchedule({ kind: "cron", expression, timezone });
}

assert.throws(() => cron("not cron", "UTC"), /Invalid cron/);
assert.throws(() => cron("* * * * *", "Mars/Olympus"), /Invalid timezone/);

// Spring-forward shifts the nonexistent 02:30 to 03:30; fall-back chooses the
// first 01:30 and does not invent a duplicate wall-clock occurrence.
assert.equal(
  nextOccurrence(cron("30 2 * * *", "America/New_York"), new Date("2026-03-08T06:59:00Z")),
  "2026-03-08T07:30:00.000Z",
);
assert.equal(
  nextOccurrence(cron("30 1 * * *", "America/New_York"), new Date("2026-11-01T04:59:00Z")),
  "2026-11-01T05:30:00.000Z",
);

const store = createPgMemStore();
await store.init();
const account = await store.findOrCreateAccount("schedule@example.com");
const occurrence = "2026-07-26T12:00:00.000Z";
const definition = await store.createAutomationDefinition(account.id, {
  name: "Health report",
  templateCiphertext: "opaque:v1:ciphertext",
  nodeLabel: "bivy/laptop",
  // Schedule ticks do not carry a repo — the definition's workspace target is
  // what the node clones before starting the session.
  repo: "acme/api",
  enabled: true,
  schedule: cron("0 * * * *", "UTC"),
  nextRunAt: occurrence,
});

// Concurrent scheduler instances race the same due row. The occurrence key is
// unique and the optimistic next_run_at update has one winner.
await Promise.all([
  processDueSchedules(store, new Date(occurrence)),
  processDueSchedules(store, new Date(occurrence)),
]);
const runs = (await store.listAutomationRuns(account.id)).filter((r) => r.definitionId === definition.id);
assert.equal(runs.length, 1);
assert.equal(runs[0]?.status, "pending");
assert.equal(runs[0]?.routing.nodeLabel, "bivy/laptop");
assert.equal(runs[0]?.sourceRef?.repo, "acme/api");
// Work-item view (what the node claims) must carry the same workspace target.
const work = await store.listWorkItems(account.id);
const scheduled = work.find((w) => w.definitionId === definition.id);
assert.equal(scheduled?.repo, "acme/api");

// A restart at the same time sees an already-advanced definition.
assert.equal(await processDueSchedules(store, new Date(occurrence)), 0);
assert.equal((await store.listAutomationRuns(account.id)).filter((r) => r.definitionId === definition.id).length, 1);

const disabled = await store.createAutomationDefinition(account.id, {
  name: "Disabled",
  enabled: false,
  schedule: { kind: "once", at: occurrence },
  nextRunAt: occurrence,
});
await processDueSchedules(store, new Date(occurrence));
assert.equal((await store.listAutomationRuns(account.id)).some((r) => r.definitionId === disabled.id), false);

// Offline is represented by leaving the normal queue item pending; no online
// node lookup occurs during scheduling.
assert.equal(runs[0]?.status, "pending");

console.log("schedule tests passed");
