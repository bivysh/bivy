// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { createPgMemStore } from "../src/pg-mem-store.js";

/**
 * Cross-node session index (option b): a node replaces its session metadata; a
 * client reads the merged list across the account. The control plane stores the
 * title only as an opaque (E2E-encrypted) blob.
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
  const account = await store.findOrCreateAccount("a@example.com");
  const { node } = await store.enrollNode(account.id, "node-a", "MacBook");
  return { store, accountId: account.id, nodeId: node.id };
}

await test("replace + list round-trips metadata, never plaintext titles", async () => {
  const { store, accountId, nodeId } = await setup();
  await store.replaceNodeSessions(accountId, nodeId, [
    { sessionId: "s1", status: "working", source: "issue:#12", titleEnc: "OPAQUE_BLOB", branch: "bivy/issue-12",
      attention: [{ id: "approval-1", kind: "approval", severity: "warning", createdAt: "2026-01-01T00:00:00.000Z" }] },
  ]);
  const list = await store.listAccountSessions(accountId);
  assert.equal(list.length, 1);
  assert.equal(list[0].sessionId, "s1");
  assert.equal(list[0].nodeId, nodeId);
  assert.equal(list[0].status, "working");
  assert.equal(list[0].source, "issue:#12");
  assert.equal(list[0].titleEnc, "OPAQUE_BLOB"); // stored verbatim, never decrypted
  assert.deepEqual(list[0].attention, [{ id: "approval-1", kind: "approval", severity: "warning", createdAt: "2026-01-01T00:00:00.000Z" }]);
  assert.ok(list[0].updatedAt, "stamped with updatedAt");
});

await test("replace is full-replace (handles removals)", async () => {
  const { store, accountId, nodeId } = await setup();
  await store.replaceNodeSessions(accountId, nodeId, [
    { sessionId: "s1", status: "idle" },
    { sessionId: "s2", status: "idle" },
  ]);
  await store.replaceNodeSessions(accountId, nodeId, [{ sessionId: "s2", status: "working" }]);
  const list = await store.listAccountSessions(accountId);
  assert.deepEqual(list.map((s) => s.sessionId), ["s2"]);
  assert.equal(list[0].status, "working");
});

await test("foreign / unknown nodes are ignored", async () => {
  const { store, accountId } = await setup();
  const other = await store.findOrCreateAccount("b@example.com");
  // account A cannot write to a node it does not own, and unknown nodes no-op.
  await store.replaceNodeSessions(other.id, "node-a", [{ sessionId: "x", status: "idle" }]);
  await store.replaceNodeSessions(accountId, "ghost", [{ sessionId: "y", status: "idle" }]);
  assert.equal((await store.listAccountSessions(accountId)).length, 0);
  assert.equal((await store.listAccountSessions(other.id)).length, 0);
});

await test("merges across multiple nodes; removeNode clears the index", async () => {
  const { store, accountId, nodeId } = await setup();
  await store.setPlan(accountId, "pro"); // free plan caps at 1 node
  const { node: nodeB } = await store.enrollNode(accountId, "node-b", "Server");
  await store.replaceNodeSessions(accountId, nodeId, [{ sessionId: "s1", status: "idle" }]);
  await store.replaceNodeSessions(accountId, nodeB.id, [{ sessionId: "s2", status: "idle" }]);
  assert.equal((await store.listAccountSessions(accountId)).length, 2);

  await store.removeNode(accountId, nodeB.id);
  const list = await store.listAccountSessions(accountId);
  assert.deepEqual(list.map((s) => s.sessionId), ["s1"]);
});

await test("upsert updates one session in place without touching the rest", async () => {
  const { store, accountId, nodeId } = await setup();
  await store.replaceNodeSessions(accountId, nodeId, [
    { sessionId: "s1", status: "idle", titleEnc: "T1" },
    { sessionId: "s2", status: "idle", titleEnc: "T2" },
  ]);
  // Flip s1's status incrementally — s2 must survive untouched (the old code
  // read + rewrote the whole index; the upsert path must preserve it).
  await store.upsertNodeSession(accountId, nodeId, { sessionId: "s1", status: "working", titleEnc: "T1" });
  const list = await store.listAccountSessions(accountId);
  assert.deepEqual([...list.map((s) => s.sessionId)].sort(), ["s1", "s2"]);
  const s1 = list.find((s) => s.sessionId === "s1")!;
  const s2 = list.find((s) => s.sessionId === "s2")!;
  assert.equal(s1.status, "working");
  assert.equal(s2.status, "idle", "sibling session is left untouched");
  assert.equal(s2.titleEnc, "T2");
});

await test("upsert inserts a brand-new session", async () => {
  const { store, accountId, nodeId } = await setup();
  await store.upsertNodeSession(accountId, nodeId, { sessionId: "new", status: "working", branch: "bivy/x" });
  const list = await store.listAccountSessions(accountId);
  assert.deepEqual(list.map((s) => s.sessionId), ["new"]);
  assert.equal(list[0].status, "working");
  assert.equal(list[0].branch, "bivy/x");
});

await test("upsert ignores foreign / unknown nodes", async () => {
  const { store, accountId } = await setup();
  const other = await store.findOrCreateAccount("b@example.com");
  await store.upsertNodeSession(other.id, "node-a", { sessionId: "x", status: "idle" });
  await store.upsertNodeSession(accountId, "ghost", { sessionId: "y", status: "idle" });
  assert.equal((await store.listAccountSessions(accountId)).length, 0);
  assert.equal((await store.listAccountSessions(other.id)).length, 0);
});

console.log(`\nsession-index: ${passed} tests passed`);
