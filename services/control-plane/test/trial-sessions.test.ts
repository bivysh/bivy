// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { createPgMemStore } from "../src/pg-mem-store.js";

/**
 * Lifetime hosted-session trial ledger. Every distinct session an account surfaces
 * through the hosted index is recorded once in `trial_sessions` (durable, never
 * pruned). `countTrialSessions` is the lifetime meter; `overTrialSessionIds` names
 * the sessions beyond the plan's allowance (the ones the client-facing list hides).
 */

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

async function setup() {
  const store = createPgMemStore();
  await store.init();
  const account = await store.findOrCreateAccount("trial@example.com");
  const { node } = await store.enrollNode(account.id, "node-a", "MacBook");
  return { store, accountId: account.id, nodeId: node.id };
}

await test("counts each distinct session once, across advertise and re-advertise", async () => {
  const { store, accountId, nodeId } = await setup();
  await store.replaceNodeSessions(accountId, nodeId, [
    { sessionId: "s1", status: "working" },
    { sessionId: "s2", status: "idle" },
  ]);
  assert.equal(await store.countTrialSessions(accountId), 2);
  // Re-advertising the same sessions (a status flip, a full resync) must not inflate
  // the lifetime count — the ledger is deduped by (account, session).
  await store.replaceNodeSessions(accountId, nodeId, [{ sessionId: "s1", status: "idle" }]);
  await store.upsertNodeSession(accountId, nodeId, { sessionId: "s2", status: "working" });
  assert.equal(await store.countTrialSessions(accountId), 2, "re-advertise is a no-op for the meter");
});

await test("count survives run_starts pruning (the trial ledger is never pruned)", async () => {
  const { store, accountId, nodeId } = await setup();
  await store.replaceNodeSessions(accountId, nodeId, [{ sessionId: "s1", status: "idle" }]);
  // Prune everything the rolling run-window cleanup could ever remove.
  await store.pruneRunStartsBefore(new Date("2999-01-01T00:00:00.000Z").toISOString());
  assert.equal(await store.countTrialSessions(accountId), 1, "trial meter is durable");
});

await test("upsert-inserted sessions land in the ledger too", async () => {
  const { store, accountId, nodeId } = await setup();
  await store.upsertNodeSession(accountId, nodeId, { sessionId: "only", status: "working" });
  assert.equal(await store.countTrialSessions(accountId), 1);
});

await test("overTrialSessionIds withholds only sessions beyond the limit, oldest-first", async () => {
  const { store, accountId, nodeId } = await setup();
  // Advertise one at a time so first_seen ordering is deterministic.
  for (const id of ["s1", "s2", "s3", "s4"]) {
    await store.upsertNodeSession(accountId, nodeId, { sessionId: id, status: "idle" });
  }
  assert.equal(await store.countTrialSessions(accountId), 4);
  // Within allowance → nothing hidden.
  assert.deepEqual([...(await store.overTrialSessionIds(accountId, 4))], []);
  assert.deepEqual([...(await store.overTrialSessionIds(accountId, 10))], []);
  // Limit of 2 → the two OLDEST stay visible, the two newest are withheld.
  const over = await store.overTrialSessionIds(accountId, 2);
  assert.deepEqual([...over].sort(), ["s3", "s4"], "earliest sessions stay; newest are gated");
});

await test("ledger is account-scoped", async () => {
  const { store, accountId, nodeId } = await setup();
  const other = await store.findOrCreateAccount("other@example.com");
  await store.replaceNodeSessions(accountId, nodeId, [{ sessionId: "s1", status: "idle" }]);
  assert.equal(await store.countTrialSessions(accountId), 1);
  assert.equal(await store.countTrialSessions(other.id), 0);
});

console.log(`\ntrial-sessions: ${passed} tests passed`);
