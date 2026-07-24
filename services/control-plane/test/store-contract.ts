// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import type { MeshStore } from "../src/store.js";

/**
 * Shared, implementation-agnostic contract suite for `MeshStore`.
 *
 * Exercises the full store surface (accounts & auth, link grants, session index,
 * inbound hooks, the work queue, and notification preferences) against whichever
 * store a factory hands it. It runs against the sole implementation, `PostgresStore`,
 * backed by pg-mem (an in-memory Postgres) — so the actual Postgres SQL/DDL is
 * exercised with no live database (test/store-contract.test.ts). A factory (not a
 * single instance) is taken so each test gets a fresh, isolated in-memory schema.
 */
export type StoreFactory = () => MeshStore | Promise<MeshStore>;

export async function runStoreContract(label: string, makeStore: StoreFactory): Promise<number> {
  let passed = 0;
  async function test(name: string, fn: (store: MeshStore) => Promise<void>) {
    const store = await makeStore();
    await store.init();
    await fn(store);
    passed += 1;
    console.log(`  ✓ [${label}] ${name}`);
  }

  // --- Accounts & auth -------------------------------------------------------
  await test("accounts are created idempotently by email, defaulting to free", async (store) => {
    const a = await store.findOrCreateAccount("contract-a@example.com");
    assert.equal(a.plan, "free");
    const again = await store.findOrCreateAccount("contract-a@example.com");
    assert.equal(again.id, a.id);
    assert.equal((await store.getAccount(a.id))?.email, "contract-a@example.com");
  });

  await test("magic-link tokens resolve once, then are spent", async (store) => {
    const token = await store.createLoginToken("contract-login@example.com");
    assert.equal((await store.consumeLoginToken(token))?.email, "contract-login@example.com");
    assert.equal(await store.consumeLoginToken(token), undefined);
  });

  await test("sessions resolve until revoked", async (store) => {
    const acct = await store.findOrCreateAccount("contract-sess@example.com");
    const token = await store.createSession(acct.id);
    assert.equal((await store.accountFromSession(token))?.id, acct.id);
    await store.revokeSession(token);
    assert.equal(await store.accountFromSession(token), undefined);
  });

  await test("device login: pending → complete mints a session at poll time", async (store) => {
    const acct = await store.findOrCreateAccount("contract-device@example.com");
    const { deviceId, deviceSecret } = await store.createDeviceLogin();
    assert.deepEqual(await store.pollDeviceLogin(deviceId, deviceSecret), { status: "pending" });
    await store.completeDeviceLogin(deviceId, acct.id);
    const done = await store.pollDeviceLogin(deviceId, deviceSecret);
    assert.equal(done.status, "complete");
    if (done.status === "complete") assert.equal((await store.accountFromSession(done.token))?.id, acct.id);
    // Single delivery: a second poll no longer completes.
    assert.equal((await store.pollDeviceLogin(deviceId, deviceSecret)).status, "expired");
  });

  // --- Link grants & relay tickets ------------------------------------------
  await test("link grants scope a client to one node; relay tickets are single-use", async (store) => {
    const acct = await store.findOrCreateAccount("contract-grant@example.com");
    const grant = await store.createLinkGrant(acct.id, "node-x");
    const resolved = await store.resolveClient(grant);
    assert.equal(resolved?.accountId, acct.id);
    assert.equal(resolved?.nodeId, "node-x");

    const ticket = await store.createRelayTicket({ role: "node", accountId: acct.id, nodeId: "node-x" });
    assert.equal((await store.consumeRelayTicket(ticket))?.nodeId, "node-x");
    assert.equal(await store.consumeRelayTicket(ticket), undefined);
  });

  // --- Session index ---------------------------------------------------------
  await test("session index merges a node's adverts and is account-scoped", async (store) => {
    const acct = await store.findOrCreateAccount("contract-index@example.com");
    const { node } = await store.enrollNode(acct.id, "node-idx", "Laptop");
    await store.replaceNodeSessions(acct.id, node.id, [
      { sessionId: "s1", status: "working", source: "issue:#1", branch: "main", agentServiceAddress: "unix:/run/bivy-agent.sock" },
      { sessionId: "s2", status: "idle" },
    ]);
    const listed = await store.listAccountSessions(acct.id);
    assert.deepEqual(listed.map((s) => s.sessionId).sort(), ["s1", "s2"]);
    assert.equal(listed.every((s) => s.nodeId === node.id), true);
    // Stage 2: the agent-service address round-trips (and is absent when unset).
    assert.equal(listed.find((s) => s.sessionId === "s1")?.agentServiceAddress, "unix:/run/bivy-agent.sock");
    assert.equal(listed.find((s) => s.sessionId === "s2")?.agentServiceAddress, undefined);
    // Replacing swaps the full set for that node.
    await store.replaceNodeSessions(acct.id, node.id, [{ sessionId: "s3", status: "idle" }]);
    assert.deepEqual((await store.listAccountSessions(acct.id)).map((s) => s.sessionId), ["s3"]);
    // A foreign account sees nothing.
    const other = await store.findOrCreateAccount("contract-index2@example.com");
    assert.equal((await store.listAccountSessions(other.id)).length, 0);
  });

  // Stage 3: a node reads back its OWN rows, WITH the agent-service address, and
  // is scoped both to the account and to the single node (never other nodes').
  await test("listNodeSessions is node-scoped and retains the agent-service address", async (store) => {
    const acct = await store.findOrCreateAccount("contract-nodesessions@example.com");
    await store.setPlan(acct.id, "pro"); // lift the free plan's 1-node cap
    const { node: a } = await store.enrollNode(acct.id, "node-adopt-a", "Laptop A");
    const { node: b } = await store.enrollNode(acct.id, "node-adopt-b", "Laptop B");
    await store.replaceNodeSessions(acct.id, a.id, [
      { sessionId: "sa", status: "idle", agentServiceAddress: "unix:/run/a.sock" },
    ]);
    await store.replaceNodeSessions(acct.id, b.id, [
      { sessionId: "sb", status: "idle", agentServiceAddress: "10.0.0.4:4711" },
    ]);
    const aRows = await store.listNodeSessions(acct.id, a.id);
    assert.deepEqual(aRows.map((s) => s.sessionId), ["sa"], "only node A's own rows");
    assert.equal(aRows[0]?.nodeId, a.id);
    assert.equal(aRows[0]?.agentServiceAddress, "unix:/run/a.sock", "address is NOT stripped for the node view");
    // Scoped by account too: a foreign account passing node A's id sees nothing.
    const outsider = await store.findOrCreateAccount("contract-nodesessions2@example.com");
    assert.equal((await store.listNodeSessions(outsider.id, a.id)).length, 0);
  });

  // --- Session replication ownership (docs/session-replication.md) -----------
  await test("session ownership: standby round-trips and promotion is a compare-and-set on the epoch", async (store) => {
    const acct = await store.findOrCreateAccount("contract-ownership@example.com");
    await store.setPlan(acct.id, "pro"); // lift the free plan's 1-node cap
    const { node: a } = await store.enrollNode(acct.id, "own-a", "Laptop A");
    const { node: b } = await store.enrollNode(acct.id, "own-b", "Laptop B");

    // Not replicated yet.
    assert.equal(await store.getSessionOwnership(acct.id, "s1"), undefined);

    // Owner A declares B as the standby; epoch starts at 0.
    const declared = await store.setSessionStandby(acct.id, "s1", a.id, b.id);
    assert.equal(declared.ownerNodeId, a.id);
    assert.equal(declared.standbyNodeId, b.id);
    assert.equal(declared.ownerEpoch, 0);

    // Re-declaring (e.g. owner reconnect) must NOT reset the epoch.
    const redeclared = await store.setSessionStandby(acct.id, "s1", a.id, b.id);
    assert.equal(redeclared.ownerEpoch, 0, "epoch is stable across re-declare");

    // A stale promotion (wrong expected epoch) is rejected — the fence holds.
    assert.equal(await store.promoteSession(acct.id, "s1", b.id, 7), undefined);
    assert.equal((await store.getSessionOwnership(acct.id, "s1"))?.ownerNodeId, a.id, "owner unchanged after a lost race");

    // A correct promotion moves ownership to B, bumps the epoch, clears standby.
    const promoted = await store.promoteSession(acct.id, "s1", b.id, 0);
    assert.equal(promoted?.ownerNodeId, b.id);
    assert.equal(promoted?.ownerEpoch, 1);
    assert.equal(promoted?.standbyNodeId, undefined, "standby cleared on promotion");

    // The old epoch no longer works (can't double-promote) — idempotent under retry.
    assert.equal(await store.promoteSession(acct.id, "s1", a.id, 0), undefined);
    assert.equal((await store.getSessionOwnership(acct.id, "s1"))?.ownerNodeId, b.id);

    // Foreign accounts see nothing.
    const other = await store.findOrCreateAccount("contract-ownership2@example.com");
    assert.equal(await store.getSessionOwnership(other.id, "s1"), undefined);
  });

  // --- Inbound hooks ---------------------------------------------------------
  await test("inbound hooks: create, app-meta, serving node cleared on node delete", async (store) => {
    const acct = await store.findOrCreateAccount("contract-hook@example.com");
    const { node } = await store.enrollNode(acct.id, "node-h", "Laptop");
    const hook = await store.createInboundHook(acct.id, "github_app");
    assert.equal((await store.getInboundHook(hook.id))?.accountId, acct.id);

    await store.setInboundHookAppMeta(acct.id, hook.id, { mention: "bivy-app", name: "Bivy App", appId: "42" });
    const served = await store.setInboundHookServingNode(acct.id, hook.id, node.id);
    assert.equal(served?.servingNodeId, node.id);
    assert.equal((await store.getGithubAppHook(acct.id))?.botMention, "bivy-app");

    // install count is floored + clamped
    assert.equal((await store.setInboundHookInstallStatus(acct.id, hook.id, 2.9))?.installCount, 2);

    // Removing the serving node clears the pointer (no stale "connected").
    assert.equal(await store.removeNode(acct.id, node.id), true);
    assert.equal((await store.getGithubAppHook(acct.id))?.servingNodeId, undefined);
    // Foreign account cannot mutate the hook.
    const other = await store.findOrCreateAccount("contract-hook2@example.com");
    assert.equal(await store.setInboundHookSecret(other.id, hook.id, "nope"), undefined);
  });

  // --- Work queue ------------------------------------------------------------
  await test("work queue: enqueue, label routing, atomic claim, complete", async (store) => {
    const acct = await store.findOrCreateAccount("contract-wq@example.com");
    const { node } = await store.enrollNode(acct.id, "node-wq", "Laptop");
    const a = await store.enqueueWorkItem(acct.id, { label: "bivy", source: "github:issue", title: "A" });
    await store.enqueueWorkItem(acct.id, { label: "bivy/laptop", source: "slack", title: "B" });

    assert.deepEqual((await store.listPendingWorkItems(acct.id, ["bivy"])).map((w) => w.title), ["A"]);
    assert.deepEqual(
      (await store.listPendingWorkItems(acct.id, ["bivy", "bivy/laptop"])).map((w) => w.title),
      ["A", "B"],
    );
    // Blank label normalizes to the shared "bivy" queue.
    const blank = await store.enqueueWorkItem(acct.id, { label: "   ", source: "slack", title: "C" });
    assert.equal(blank.label, "bivy");

    const claimed = await store.claimWorkItem(acct.id, node.id, a.id);
    assert.equal(claimed?.status, "claimed");
    assert.equal(await store.claimWorkItem(acct.id, node.id, a.id), undefined); // second claim loses
    await store.completeWorkItem(acct.id, a.id);
    assert.equal((await store.listWorkItems(acct.id)).find((w) => w.id === a.id)?.status, "done");
  });

  await test("work queue: dedupeKey is idempotent per account", async (store) => {
    const acct = await store.findOrCreateAccount("contract-dedupe@example.com");
    const first = await store.enqueueWorkItem(acct.id, { source: "github:issue", title: "Fix", dedupeKey: "gh:1" });
    const again = await store.enqueueWorkItem(acct.id, { source: "github:issue", title: "Fix (redeliver)", dedupeKey: "gh:1" });
    assert.equal(again.id, first.id);
    assert.equal(again.title, "Fix");
    assert.equal((await store.listWorkItems(acct.id)).length, 1);
  });

  await test("work queue: reroute + assign only affect pending items", async (store) => {
    const acct = await store.findOrCreateAccount("contract-route@example.com");
    const shared = await store.enqueueWorkItem(acct.id, { source: "github:issue", title: "s", label: "bivy", defaultRouted: true });
    const moved = await store.rerouteDefaultRoutedPending(acct.id, "bivy/laptop");
    assert.deepEqual(moved.map((w) => w.id), [shared.id]);
    const assigned = await store.assignWorkItem(acct.id, shared.id, { label: "bivy/desktop", runtimeId: "cc", model: "m" });
    assert.equal(assigned?.label, "bivy/desktop");
    assert.equal(assigned?.defaultRouted, false);
    assert.equal(assigned?.ephemeral, false, "unset ephemeral defaults to false, not undefined, once assigned");
    assert.equal(await store.assignWorkItem(acct.id, "missing", { label: "bivy" }), undefined);
  });

  // Issue #532: a queue item dispatched to a just-provisioned ephemeral server
  // (rather than an already-running node) is still just a label assignment —
  // `ephemeral` is a display flag on top, not a different code path.
  await test("work queue: assign can mark an item as routed to an ephemeral server", async (store) => {
    const acct = await store.findOrCreateAccount("contract-ephemeral-assign@example.com");
    const item = await store.enqueueWorkItem(acct.id, { source: "github:issue", title: "e", label: "bivy" });
    const assigned = await store.assignWorkItem(acct.id, item.id, { label: "bivy/eph-ab12cd34", ephemeral: true });
    assert.equal(assigned?.label, "bivy/eph-ab12cd34");
    assert.equal(assigned?.ephemeral, true);
    assert.equal((await store.listWorkItems(acct.id)).find((w) => w.id === item.id)?.ephemeral, true);
  });

  await test("work queue: delete + clear pending, cross-account isolation", async (store) => {
    const acct = await store.findOrCreateAccount("contract-clear@example.com");
    const { node } = await store.enrollNode(acct.id, "node-cl", "N");
    const a = await store.enqueueWorkItem(acct.id, { source: "github:issue", title: "a" });
    const running = await store.enqueueWorkItem(acct.id, { source: "github:issue", title: "c" });
    await store.claimWorkItem(acct.id, node.id, running.id);
    assert.equal(await store.deleteWorkItem(acct.id, a.id), true);
    assert.equal(await store.clearPendingWorkItems(acct.id), 0); // only the claimed one remains
    assert.deepEqual((await store.listWorkItems(acct.id)).map((w) => w.id), [running.id]);
    const other = await store.findOrCreateAccount("contract-clear2@example.com");
    assert.equal(await store.deleteWorkItem(other.id, running.id), false);
  });

  // --- Notification preferences ---------------------------------------------
  await test("notification prefs default to all-on and merge partial patches", async (store) => {
    const acct = await store.findOrCreateAccount("contract-prefs@example.com");
    const defaults = await store.getNotificationPreferences(acct.id);
    assert.equal(Object.values(defaults).every((v) => v === true), true);
    const merged = await store.setNotificationPreferences(acct.id, { session_done: false });
    assert.equal(merged.session_done, false);
    assert.equal(merged.question_asked, true); // untouched kinds stay enabled
    assert.equal((await store.getNotificationPreferences(acct.id)).session_done, false);
  });

  // --- Ephemeral queue default (issue #532) ----------------------------------
  await test("ephemeral queue default: disabled by default, merges partial patches", async (store) => {
    const acct = await store.findOrCreateAccount("contract-eph-default@example.com");
    const defaults = await store.getEphemeralQueueDefault(acct.id);
    assert.equal(defaults.enabled, false);
    assert.equal(defaults.provider, undefined);

    const merged = await store.setEphemeralQueueDefault(acct.id, { enabled: true, provider: "hetzner", region: "nbg1" });
    assert.equal(merged.enabled, true);
    assert.equal(merged.provider, "hetzner");
    assert.equal(merged.region, "nbg1");

    // A later patch merges onto what's saved rather than replacing it wholesale.
    const patched = await store.setEphemeralQueueDefault(acct.id, { size: "cpx21" });
    assert.equal(patched.provider, "hetzner", "untouched fields survive a partial patch");
    assert.equal(patched.size, "cpx21");
    assert.equal((await store.getEphemeralQueueDefault(acct.id)).size, "cpx21");

    // ttlMinutes is clamped into a sane range rather than accepted verbatim.
    const clamped = await store.setEphemeralQueueDefault(acct.id, { ttlMinutes: 1 });
    assert.equal(clamped.ttlMinutes, 5);
  });

  // --- Entitlements & node limits -------------------------------------------
  await test("free plan caps nodes at 1; upgrading lifts the cap", async (store) => {
    // The cap only bites when entitlements are enforced (Bivy Cloud); a self-host
    // stack, where every account reads as free, must not be held to it.
    const prev = process.env.ENFORCE_ENTITLEMENTS;
    process.env.ENFORCE_ENTITLEMENTS = "1";
    try {
      const acct = await store.findOrCreateAccount("contract-limit@example.com");
      await store.enrollNode(acct.id, "n1", "First");
      await assert.rejects(
        () => store.enrollNode(acct.id, "n2", "Second"),
        (err: unknown) => (err as { status?: number }).status === 402,
      );
      await store.setPlan(acct.id, "pro");
      assert.equal((await store.enrollNode(acct.id, "n2", "Second")).node.id, "n2");
    } finally {
      process.env.ENFORCE_ENTITLEMENTS = prev;
    }
  });

  return passed;
}
