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

// A scheduled CHAT MESSAGE (message:true) carries its target and message flag
// end-to-end: definition → run → work-item view (what the node claims), and
// calls the enqueued callback so connected relays can be poked immediately.
// Scoped to a fresh account so the cron definition above (which re-fires as its
// next_run_at keeps advancing) can't leak into this block's callback count.
const msgAccount = await store.findOrCreateAccount("scheduled-message@example.com");
let enqueuedCallbackCount = 0;
let enqueuedRun: { accountId: string; message?: boolean; target?: { kind: string; sessionId?: string } } | undefined;
const scheduledMessage = await store.createAutomationDefinition(msgAccount.id, {
  name: "Scheduled message",
  templateCiphertext: "bivy-room-v1:node-x:cipher",
  nodeLabel: "bivy/laptop",
  enabled: true,
  schedule: { kind: "once", at: "2026-07-26T12:30:00.000Z" },
  nextRunAt: "2026-07-26T12:30:00.000Z",
  target: { kind: "existing_session", sessionId: "sess-9" },
  message: true,
});
await processDueSchedules(store, new Date("2026-07-26T12:30:00.000Z"), (accountId, run) => {
  enqueuedCallbackCount += 1;
  enqueuedRun = { accountId, message: run.message, target: run.target };
});
assert.equal(enqueuedCallbackCount, 1);
assert.equal(enqueuedRun?.accountId, msgAccount.id);
assert.equal(enqueuedRun?.message, true);
assert.deepEqual(enqueuedRun?.target, { kind: "existing_session", sessionId: "sess-9" });
const msgRun = (await store.listAutomationRuns(msgAccount.id)).find((r) => r.definitionId === scheduledMessage.id);
assert.equal(msgRun?.message, true);
assert.deepEqual(msgRun?.target, { kind: "existing_session", sessionId: "sess-9" });
const msgWork = (await store.listWorkItems(msgAccount.id)).find((w) => w.definitionId === scheduledMessage.id);
assert.equal(msgWork?.message, true);
assert.equal(msgWork?.targetKind, "existing_session");
assert.equal(msgWork?.targetSessionId, "sess-9");
// A plain (non-message) automation defaults to a fresh session with no flag.
const autoRun = (await store.listAutomationRuns(account.id)).find((r) => r.definitionId === definition.id);
assert.equal(autoRun?.message, undefined);
assert.deepEqual(autoRun?.target, { kind: "new_session" });

console.log("schedule tests passed");
