// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Case B: an inbound issue/comment should CONTINUE an already-indexed session
// (target existing_session) rather than start a fresh one. Covers the store-level
// lookup (findSessionByIssue over session_index.source) and that the work-item
// target round-trips through enqueue.
import assert from "node:assert/strict";
import { createPgMemStore } from "../src/pg-mem-store.js";

async function makeStore() {
  const store = createPgMemStore();
  await store.init();
  return store;
}

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

await test("findSessionByIssue matches the node's issue: source", async () => {
  const store = await makeStore();
  const acct = await store.findOrCreateAccount("a@example.com");
  await store.enrollNode(acct.id, "node-1", "Laptop");
  await store.replaceNodeSessions(acct.id, "node-1", [
    { sessionId: "sess-42", status: "idle", source: "issue:acme/widgets#42" },
    { sessionId: "sess-other", status: "idle", source: "issue:acme/widgets#7" },
  ]);
  const hit = await store.findSessionByIssue(acct.id, "acme/widgets", 42);
  assert.deepEqual(hit, { sessionId: "sess-42", nodeId: "node-1" });
  // A different issue number / repo does not match.
  assert.equal(await store.findSessionByIssue(acct.id, "acme/widgets", 999), undefined);
  assert.equal(await store.findSessionByIssue(acct.id, "acme/other", 42), undefined);
});

await test("findSessionByIssue is account-scoped", async () => {
  const store = await makeStore();
  const a = await store.findOrCreateAccount("a2@example.com");
  const b = await store.findOrCreateAccount("b2@example.com");
  await store.enrollNode(a.id, "na", "A");
  await store.replaceNodeSessions(a.id, "na", [{ sessionId: "s1", status: "idle", source: "issue:o/r#1" }]);
  assert.ok(await store.findSessionByIssue(a.id, "o/r", 1));
  assert.equal(await store.findSessionByIssue(b.id, "o/r", 1), undefined);
});

await test("findSessionByExternalId matches the node's linear: source", async () => {
  const store = await makeStore();
  const acct = await store.findOrCreateAccount("lin@example.com");
  await store.enrollNode(acct.id, "node-l", "Laptop");
  await store.replaceNodeSessions(acct.id, "node-l", [
    { sessionId: "sess-abc", status: "idle", source: "linear:abc-123" },
    { sessionId: "sess-other", status: "idle", source: "linear:xyz-999" },
  ]);
  const hit = await store.findSessionByExternalId(acct.id, "abc-123");
  assert.deepEqual(hit, { sessionId: "sess-abc", nodeId: "node-l" });
  // A different external id does not match; a GitHub issue source does not leak in.
  assert.equal(await store.findSessionByExternalId(acct.id, "nope"), undefined);
});

await test("findSessionByExternalId is account-scoped", async () => {
  const store = await makeStore();
  const a = await store.findOrCreateAccount("la@example.com");
  const b = await store.findOrCreateAccount("lb@example.com");
  await store.enrollNode(a.id, "na", "A");
  await store.replaceNodeSessions(a.id, "na", [{ sessionId: "s1", status: "idle", source: "linear:iss-1" }]);
  assert.ok(await store.findSessionByExternalId(a.id, "iss-1"));
  assert.equal(await store.findSessionByExternalId(b.id, "iss-1"), undefined);
});

await test("enqueue carries an existing_session target end-to-end", async () => {
  const store = await makeStore();
  const acct = await store.findOrCreateAccount("c@example.com");
  const item = await store.enqueueWorkItem(acct.id, {
    label: "bivy", source: "github:comment", title: "GitHub issue #42",
    repo: "acme/widgets", issueNumber: 42,
    target: { kind: "existing_session", sessionId: "sess-42" },
  });
  assert.equal(item.targetKind, "existing_session");
  assert.equal(item.targetSessionId, "sess-42");
  // And the default (no target) stays new_session.
  const fresh = await store.enqueueWorkItem(acct.id, { label: "bivy", source: "github:issue", title: "New" });
  assert.equal(fresh.targetKind, "new_session");
  assert.equal(fresh.targetSessionId, undefined);
});

await test("scheduled-message automation definition round-trips target + message", async () => {
  const store = await makeStore();
  const acct = await store.findOrCreateAccount("dm@example.com");
  const def = await store.createAutomationDefinition(acct.id, {
    name: "Scheduled message",
    templateCiphertext: "bivy-room-v1:node-x:cipher",
    nodeLabel: "bivy/laptop",
    schedule: { kind: "once", at: "2026-07-27T09:00:00.000Z" },
    nextRunAt: "2026-07-27T09:00:00.000Z",
    target: { kind: "existing_session", sessionId: "sess-9" },
    message: true,
    enabled: true,
  });
  const got = await store.getAutomationDefinition(acct.id, def.id);
  assert.deepEqual(got?.target, { kind: "existing_session", sessionId: "sess-9" });
  assert.equal(got?.message, true);
  // Updating clears the target (back to a fresh session) and flips message off.
  const updated = await store.updateAutomationDefinition(acct.id, def.id, { target: undefined, message: false });
  assert.equal(updated?.target, undefined);
  assert.equal(updated?.message, undefined);
  // A plain automation defaults to no target and no message flag.
  const plain = await store.createAutomationDefinition(acct.id, {
    name: "Nightly", enabled: true,
    schedule: { kind: "once", at: "2026-07-28T09:00:00.000Z" },
    nextRunAt: "2026-07-28T09:00:00.000Z",
  });
  assert.equal(plain.target, undefined);
  assert.equal(plain.message, undefined);
});

console.log(`case-b-targeting: ${passed} test(s) passed`);
