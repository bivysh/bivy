// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { entitlementsForPlan } from "../src/store.js";
import { createPgMemStore } from "../src/pg-mem-store.js";

/**
 * Fast, in-process unit tests for the control-plane store. Runs the REAL
 * PostgresStore backed by pg-mem (an in-memory Postgres — no network/live DB), so
 * every PR is gated against the same SQL/DDL production runs. The former in-process
 * MemoryStore has been retired; there is now one store implementation.
 */

/** A fresh, initialized in-memory store (pg-mem-backed PostgresStore). */
async function makeStore() {
  const store = createPgMemStore();
  await store.init();
  return store;
}

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

await test("new accounts default to the free plan with empty billing metadata", async () => {
  const store = await makeStore();
  const account = await store.findOrCreateAccount("a@example.com");
  assert.equal(account.plan, "free");
  assert.equal(account.stripeCustomerId, null);
  assert.equal(account.stripeSubscriptionId, null);
  assert.equal(account.subscriptionStatus, null);
  assert.equal(account.planUpdatedAt, null);
  // findOrCreate is idempotent by email.
  const again = await store.findOrCreateAccount("a@example.com");
  assert.equal(again.id, account.id);
});

await test("sessions can be created, resolved, and revoked (logout)", async () => {
  const store = await makeStore();
  const account = await store.findOrCreateAccount("b@example.com");
  const token = await store.createSession(account.id);
  assert.equal((await store.accountFromSession(token))?.id, account.id);
  await store.revokeSession(token);
  assert.equal(await store.accountFromSession(token), undefined);
});

await test("magic-link login tokens are single-use", async () => {
  const store = await makeStore();
  const token = await store.createLoginToken("c@example.com");
  const first = await store.consumeLoginToken(token);
  assert.equal(first?.email, "c@example.com");
  assert.equal(await store.consumeLoginToken(token), undefined);
});

await test("enrollNode enforces the plan's maxNodes limit", async () => {
  const store = await makeStore();
  const account = await store.findOrCreateAccount("d@example.com");
  assert.equal(entitlementsForPlan("free").maxNodes, 1);
  await store.enrollNode(account.id, "node-1", "First");
  await assert.rejects(
    () => store.enrollNode(account.id, "node-2", "Second"),
    (err: unknown) => (err as { status?: number }).status === 402,
  );
  // Upgrading the plan lifts the limit — paid plans are unlimited (no cap).
  await store.setPlan(account.id, "individual");
  const result = await store.enrollNode(account.id, "node-2", "Second");
  assert.equal(result.node.id, "node-2");
  // A third (and beyond) also enrolls — unlimited means unlimited.
  const third = await store.enrollNode(account.id, "node-3", "Third");
  assert.equal(third.node.id, "node-3");
});

await test("registerPairedDevice has no device cap (limits removed)", async () => {
  const store = await makeStore();
  const account = await store.findOrCreateAccount("dev-limit@example.com");
  // The free plan no longer has a device cap. Pair well past the old cap of 2 —
  // none are rejected.
  for (let i = 0; i < 5; i++) {
    await store.registerPairedDevice(account.id, `pubkey-${i}`, `Device ${i}`);
  }
  assert.equal(await store.countPairedDevices(account.id), 5);
  // Re-registering an already-paired device (same public key) updates in place.
  await store.registerPairedDevice(account.id, "pubkey-0", "Renamed");
  assert.equal(await store.countPairedDevices(account.id), 5);
});

await test("registerPairedDevice refuses to move a device to a different account", async () => {
  const store = await makeStore();
  const owner = await store.findOrCreateAccount("owner@example.com");
  const intruder = await store.findOrCreateAccount("intruder@example.com");
  await store.registerPairedDevice(owner.id, "shared-pubkey", "Phone");
  await assert.rejects(
    () => store.registerPairedDevice(intruder.id, "shared-pubkey", "Phone"),
    (err: unknown) => (err as { status?: number }).status === 409,
  );
});

await test("listPairedDevices and removePairedDevice manage the account's devices", async () => {
  const store = await makeStore();
  const account = await store.findOrCreateAccount("devices@example.com");
  const other = await store.findOrCreateAccount("other@example.com");
  await store.registerPairedDevice(account.id, "pk-a", "Phone");
  await store.registerPairedDevice(account.id, "pk-b", "Laptop");
  await store.registerPairedDevice(other.id, "pk-c", "Intruder");

  const listed = await store.listPairedDevices(account.id);
  assert.deepEqual(listed.map((d) => d.id).sort(), ["pk-a", "pk-b"]);
  assert.equal(listed[0].label !== undefined, true);

  // Removing another account's device is a no-op (scoped by account).
  assert.equal(await store.removePairedDevice(account.id, "pk-c"), false);
  assert.equal(await store.countPairedDevices(other.id), 1);

  // Removing your own device frees the slot.
  assert.equal(await store.removePairedDevice(account.id, "pk-a"), true);
  assert.equal(await store.countPairedDevices(account.id), 1);
  // Removing a device that's already gone returns false.
  assert.equal(await store.removePairedDevice(account.id, "pk-a"), false);
});

await test("free vs individual entitlements match the published pricing table", () => {
  const free = entitlementsForPlan("free");
  assert.equal(free.maxNodes, 1, "free: one machine");
  // Device and session caps were removed for every plan (fields no longer exist).
  assert.equal(free.pushEnabled, false, "free: no push notifications");
  assert.equal(free.relayEnabled, true, "free: one hosted relay node");
  assert.equal(free.workQueueEnabled, false, "free: no hosted work queue");

  const individual = entitlementsForPlan("individual");
  assert.equal(individual.maxNodes, undefined, "individual: unlimited nodes (no cap)");
  assert.equal(individual.pushEnabled, true, "individual: push notifications");
  assert.equal(individual.relayEnabled, true, "individual: remote relay");
  assert.equal(individual.workQueueEnabled, true, "individual: hosted work queue");

  const team = entitlementsForPlan("team");
  assert.equal(team.maxNodes, undefined, "team: unlimited nodes (no cap)");
  assert.equal(team.workQueueEnabled, true, "team: hosted work queue");
});

await test("setSubscriptionState records full billing metadata and updates entitlements", async () => {
  const store = await makeStore();
  const account = await store.findOrCreateAccount("e@example.com");
  await store.setSubscriptionState(account.id, {
    plan: "individual",
    stripeCustomerId: "cus_123",
    stripeSubscriptionId: "sub_123",
    subscriptionStatus: "active",
  });
  const updated = await store.getAccount(account.id);
  assert.equal(updated?.plan, "individual");
  assert.equal(updated?.stripeCustomerId, "cus_123");
  assert.equal(updated?.stripeSubscriptionId, "sub_123");
  assert.equal(updated?.subscriptionStatus, "active");
  assert.ok(updated?.planUpdatedAt);
  assert.equal((await store.entitlements(account.id)).relayEnabled, true);
});

await test("relay tickets are single-use", async () => {
  const store = await makeStore();
  const account = await store.findOrCreateAccount("f@example.com");
  const ticket = await store.createRelayTicket({ role: "node", accountId: account.id, nodeId: "n1" });
  const first = await store.consumeRelayTicket(ticket);
  assert.equal(first?.nodeId, "n1");
  assert.equal(await store.consumeRelayTicket(ticket), undefined);
});

await test("link grants scope a client to a single node", async () => {
  const store = await makeStore();
  const account = await store.findOrCreateAccount("g@example.com");
  const grant = await store.createLinkGrant(account.id, "node-x");
  const resolved = await store.resolveClient(grant);
  assert.equal(resolved?.accountId, account.id);
  assert.equal(resolved?.nodeId, "node-x");
});

await test("work queue: enqueue, list by label, claim (atomic), complete", async () => {
  const store = await makeStore();
  const account = await store.findOrCreateAccount("w@example.com");
  const { node } = await store.enrollNode(account.id, "node-w", "Laptop");

  const a = await store.enqueueWorkItem(account.id, { label: "bivy", source: "github:issue", title: "A", repo: "o/r", issueNumber: 1 });
  await store.enqueueWorkItem(account.id, { label: "bivy/laptop", source: "slack", title: "B" });

  // A node serving only "bivy" sees just the shared item.
  const shared = await store.listPendingWorkItems(account.id, ["bivy"]);
  assert.deepEqual(shared.map((w) => w.title), ["A"]);
  // Serving both labels sees both, oldest first.
  const both = await store.listPendingWorkItems(account.id, ["bivy", "bivy/laptop"]);
  assert.deepEqual(both.map((w) => w.title), ["A", "B"]);

  // Claim is atomic: the first claimer wins, a second returns undefined.
  const claimed = await store.claimWorkItem(account.id, node.id, a.id);
  assert.equal(claimed?.status, "claimed");
  assert.equal(claimed?.claimedByNodeId, node.id);
  assert.equal(await store.claimWorkItem(account.id, node.id, a.id), undefined);

  // Claimed items drop out of the pending list.
  const afterClaim = await store.listPendingWorkItems(account.id, ["bivy"]);
  assert.equal(afterClaim.length, 0);

  await store.completeWorkItem(account.id, a.id);
});

await test("work queue: items are account-scoped; cross-account claim is denied", async () => {
  const store = await makeStore();
  const acct1 = await store.findOrCreateAccount("one@example.com");
  const acct2 = await store.findOrCreateAccount("two@example.com");
  const { node: node2 } = await store.enrollNode(acct2.id, "node-2", "N2");
  const item = await store.enqueueWorkItem(acct1.id, { source: "slack", title: "secret" });
  // acct2's node can neither see nor claim acct1's item.
  assert.equal((await store.listPendingWorkItems(acct2.id, ["bivy"])).length, 0);
  assert.equal(await store.claimWorkItem(acct2.id, node2.id, item.id), undefined);
});

await test("inbound hooks: create + resolve by id with a per-account secret", async () => {
  const store = await makeStore();
  const account = await store.findOrCreateAccount("h@example.com");
  const hook = await store.createInboundHook(account.id, "github");
  assert.equal(hook.kind, "github");
  assert.ok(hook.secret.length > 10);
  const resolved = await store.getInboundHook(hook.id);
  assert.equal(resolved?.accountId, account.id);
  assert.equal(resolved?.secret, hook.secret);
});

await test("enqueueWorkItem is idempotent on dedupeKey (redelivery safety)", async () => {
  const store = await makeStore();
  const acct = await store.findOrCreateAccount("wq@example.com");
  const first = await store.enqueueWorkItem(acct.id, { source: "github:issue", title: "Fix", dedupeKey: "gh:abc" });
  const again = await store.enqueueWorkItem(acct.id, { source: "github:issue", title: "Fix (redelivered)", dedupeKey: "gh:abc" });
  assert.equal(again.id, first.id); // same delivery → same item, not a duplicate
  assert.equal(again.title, "Fix"); // original wins; the redelivery does not mutate it
  assert.equal((await store.listPendingWorkItems(acct.id, ["bivy"])).length, 1);
  // A different key (or no key) still creates distinct items.
  const other = await store.enqueueWorkItem(acct.id, { source: "github:issue", title: "Other", dedupeKey: "gh:xyz" });
  assert.notEqual(other.id, first.id);
  const nokey1 = await store.enqueueWorkItem(acct.id, { source: "slack", title: "a" });
  const nokey2 = await store.enqueueWorkItem(acct.id, { source: "slack", title: "a" });
  assert.notEqual(nokey1.id, nokey2.id);
  // Dedup is scoped per account: the same key under another account is independent.
  const acct2 = await store.findOrCreateAccount("wq2@example.com");
  const cross = await store.enqueueWorkItem(acct2.id, { source: "github:issue", title: "Fix", dedupeKey: "gh:abc" });
  assert.notEqual(cross.id, first.id);
});

await test("enqueueWorkItem collapses an issue's many deliveries into one pending item, but re-runs after it finishes", async () => {
  const store = await makeStore();
  const acct = await store.findOrCreateAccount("collapse@example.com");
  const { node } = await store.enrollNode(acct.id, "node-c", "Laptop");
  const key = "gh-issue:o/r#7";
  // The `opened`, `labeled`, `edited` deliveries all resolve to the same issue.
  const opened = await store.enqueueWorkItem(acct.id, { source: "github:issue", title: "Fix", repo: "o/r", issueNumber: 7, collapseKey: key, dedupeKey: "gh:d1" });
  const labeled = await store.enqueueWorkItem(acct.id, { source: "github:issue", title: "Fix (labeled)", repo: "o/r", issueNumber: 7, collapseKey: key, dedupeKey: "gh:d2" });
  const edited = await store.enqueueWorkItem(acct.id, { source: "github:issue", title: "Fix (edited)", repo: "o/r", issueNumber: 7, collapseKey: key, dedupeKey: "gh:d3" });
  assert.equal(labeled.id, opened.id, "second delivery collapses onto the first");
  assert.equal(edited.id, opened.id, "third delivery collapses too");
  assert.equal((await store.listWorkItems(acct.id)).length, 1, "only one queue entry exists");
  // Once the item leaves pending, the collapse key frees so the issue can re-run.
  await store.claimWorkItem(acct.id, node.id, opened.id);
  await store.completeWorkItem(acct.id, opened.id);
  const rerun = await store.enqueueWorkItem(acct.id, { source: "github:issue", title: "Fix again", repo: "o/r", issueNumber: 7, collapseKey: key, dedupeKey: "gh:d4" });
  assert.notEqual(rerun.id, opened.id, "a re-label after completion starts a fresh run");
});

await test("rerouteDefaultRoutedPending moves only pending default-routed items", async () => {
  const store = await makeStore();
  const acct = await store.findOrCreateAccount("reroute@example.com");
  const { node } = await store.enrollNode(acct.id, "node-r", "Laptop");
  const shared = await store.enqueueWorkItem(acct.id, { source: "github:issue", title: "shared", label: "bivy", defaultRouted: true });
  const targeted = await store.enqueueWorkItem(acct.id, { source: "github:issue", title: "targeted", label: "bivy/desktop", defaultRouted: false });
  const claimed = await store.enqueueWorkItem(acct.id, { source: "github:issue", title: "running", label: "bivy", defaultRouted: true });
  await store.claimWorkItem(acct.id, node.id, claimed.id);

  const moved = await store.rerouteDefaultRoutedPending(acct.id, "bivy/laptop");
  assert.deepEqual(moved.map((w) => w.id), [shared.id], "only the pending shared item re-routes");
  assert.equal((await store.listWorkItems(acct.id)).find((w) => w.id === shared.id)?.label, "bivy/laptop");
  // Explicitly-targeted and already-claimed items keep their label.
  assert.equal((await store.listWorkItems(acct.id)).find((w) => w.id === targeted.id)?.label, "bivy/desktop");
  assert.equal((await store.listWorkItems(acct.id)).find((w) => w.id === claimed.id)?.label, "bivy");
});

await test("assignWorkItem targets a pending item to a node + agent; rejects non-pending/unknown", async () => {
  const store = await makeStore();
  const acct = await store.findOrCreateAccount("assign@example.com");
  const { node } = await store.enrollNode(acct.id, "node-a", "Laptop");
  const item = await store.enqueueWorkItem(acct.id, { source: "github:issue", title: "Fix", label: "bivy", defaultRouted: true });

  const updated = await store.assignWorkItem(acct.id, item.id, { label: "bivy/laptop", runtimeId: "claude-code-sdk", model: "claude-sonnet-5" });
  assert.equal(updated?.label, "bivy/laptop");
  assert.equal(updated?.runtimeId, "claude-code-sdk");
  assert.equal(updated?.model, "claude-sonnet-5");
  assert.equal(updated?.defaultRouted, false, "manual assignment marks it explicitly targeted");
  // A node serving bivy/laptop now sees it.
  assert.deepEqual((await store.listPendingWorkItems(acct.id, ["bivy", "bivy/laptop"])).map((w) => w.title), ["Fix"]);
  // Unknown id and non-pending item both refuse.
  assert.equal(await store.assignWorkItem(acct.id, "nope", { label: "bivy/laptop" }), undefined);
  await store.claimWorkItem(acct.id, node.id, item.id);
  assert.equal(await store.assignWorkItem(acct.id, item.id, { label: "bivy/desktop" }), undefined);
});

await test("node names are unique per account: auto-suffix on enroll, reject on rename", async () => {
  const store = await makeStore();
  const acct = await store.findOrCreateAccount("names@example.com");
  await store.setSubscriptionState(acct.id, { plan: "individual", subscriptionStatus: "active" }); // unlimited nodes
  const a = await store.enrollNode(acct.id, "node_a", "Mac.home");
  assert.equal(a.node.name, "Mac.home");
  // A second node enrolling with the same name is auto-suffixed (hyphen, so it
  // stays valid as a bivy/<name> label + "@bot on <name>" directive).
  const b = await store.enrollNode(acct.id, "node_b", "Mac.home");
  assert.equal(b.node.name, "Mac.home-2");
  // Re-enrolling the same node id keeps its own name (excludes self).
  const aAgain = await store.enrollNode(acct.id, "node_a", "Mac.home");
  assert.equal(aAgain.node.name, "Mac.home");
  // Renaming node_b onto node_a's exact name is rejected.
  await assert.rejects(() => store.setNodeName("node_b", "Mac.home"), /already named/);
  // A free name renames fine.
  assert.equal((await store.setNodeName("node_b", "Studio"))?.name, "Studio");
  // Same name is fine under a different account (uniqueness is per-account).
  const other = await store.findOrCreateAccount("names2@example.com");
  assert.equal((await store.enrollNode(other.id, "node_c", "Mac.home")).node.name, "Mac.home");
});

await test("deleteWorkItem / clearPendingWorkItems manage the queue", async () => {
  const store = await makeStore();
  const acct = await store.findOrCreateAccount("q@example.com");
  const { node } = await store.enrollNode(acct.id, "node-q", "N");
  const a = await store.enqueueWorkItem(acct.id, { source: "github:issue", title: "a", label: "bivy" });
  const b = await store.enqueueWorkItem(acct.id, { source: "github:issue", title: "b", label: "bivy" });
  const running = await store.enqueueWorkItem(acct.id, { source: "github:issue", title: "c", label: "bivy" });
  await store.claimWorkItem(acct.id, node.id, running.id); // claimed → survives a clear

  assert.equal(await store.deleteWorkItem(acct.id, a.id), true);
  assert.equal(await store.deleteWorkItem(acct.id, a.id), false, "already gone");
  // clear removes only the remaining pending item (b), not the claimed one.
  assert.equal(await store.clearPendingWorkItems(acct.id), 1);
  const left = await store.listWorkItems(acct.id);
  assert.deepEqual(left.map((w) => w.id), [running.id]);
  // Cross-account isolation.
  const other = await store.findOrCreateAccount("q2@example.com");
  assert.equal(await store.deleteWorkItem(other.id, running.id), false);
});

await test("github app serving node: recorded on app-meta, cleared on node delete", async () => {
  const store = await makeStore();
  const acct = await store.findOrCreateAccount("gh@example.com");
  const { node } = await store.enrollNode(acct.id, "node-gh", "Laptop");
  const hook = await store.createInboundHook(acct.id, "github_app");

  // A node registering app-meta marks itself as the serving node.
  await store.setInboundHookAppMeta(acct.id, hook.id, { mention: "bivy-app", name: "Bivy App" });
  const served = await store.setInboundHookServingNode(acct.id, hook.id, node.id);
  assert.equal(served?.servingNodeId, node.id);
  assert.ok(served?.servingNodeSeenAt);
  assert.equal((await store.getGithubAppHook(acct.id))?.servingNodeId, node.id);

  // Removing that node clears the serving pointer (no more stale "connected").
  assert.equal(await store.removeNode(acct.id, node.id), true);
  assert.equal((await store.getGithubAppHook(acct.id))?.servingNodeId, undefined);
});

await test("setInboundHookSecret adopts an external secret, scoped to the account", async () => {
  const store = await makeStore();
  const acct = await store.findOrCreateAccount("hk@example.com");
  const hook = await store.createInboundHook(acct.id, "github_app");
  const updated = await store.setInboundHookSecret(acct.id, hook.id, "whsec_from_github");
  assert.equal(updated?.secret, "whsec_from_github");
  assert.equal((await store.getInboundHook(hook.id))?.secret, "whsec_from_github");
  // Another account cannot rewrite this hook's secret.
  const other = await store.findOrCreateAccount("hk2@example.com");
  assert.equal(await store.setInboundHookSecret(other.id, hook.id, "nope"), undefined);
  assert.equal((await store.getInboundHook(hook.id))?.secret, "whsec_from_github");
});

await test("setInboundHookAppMeta stores the app slug (mention) + name; getGithubAppHook finds it", async () => {
  const store = await makeStore();
  const acct = await store.findOrCreateAccount("meta@example.com");
  const hook = await store.createInboundHook(acct.id, "github_app");
  const updated = await store.setInboundHookAppMeta(acct.id, hook.id, { mention: "bivy-petter", name: "Bivy Petter", appId: "123456" });
  assert.equal(updated?.botMention, "bivy-petter");
  assert.equal(updated?.appName, "Bivy Petter");
  assert.equal(updated?.appId, "123456"); // App ID stored for the reconnect form's pre-fill
  // Found by account as THE github_app hook.
  const found = await store.getGithubAppHook(acct.id);
  assert.equal(found?.id, hook.id);
  assert.equal(found?.botMention, "bivy-petter");
  // Scoped to the owning account.
  const other = await store.findOrCreateAccount("meta2@example.com");
  assert.equal(await store.setInboundHookAppMeta(other.id, hook.id, { mention: "x" }), undefined);
  assert.equal(await store.getGithubAppHook(other.id), undefined);
});

await test("setInboundHookInstallStatus records the install count, scoped to the account", async () => {
  const store = await makeStore();
  const acct = await store.findOrCreateAccount("inst@example.com");
  const hook = await store.createInboundHook(acct.id, "github_app");
  // Never synced yet → undefined (the UI treats this as "unknown", not "zero").
  assert.equal((await store.getGithubAppHook(acct.id))?.installCount, undefined);
  // Node reports zero installs (created but not installed on any repo).
  let updated = await store.setInboundHookInstallStatus(acct.id, hook.id, 0);
  assert.equal(updated?.installCount, 0);
  assert.ok(updated?.installsSyncedAt);
  // Later installed on two repos/orgs; floored + clamped.
  updated = await store.setInboundHookInstallStatus(acct.id, hook.id, 2.9);
  assert.equal(updated?.installCount, 2);
  // Scoped to the owning account.
  const other = await store.findOrCreateAccount("inst2@example.com");
  assert.equal(await store.setInboundHookInstallStatus(other.id, hook.id, 5), undefined);
  assert.equal((await store.getGithubAppHook(acct.id))?.installCount, 2);
});

await test("setInboundHookDefaultNode sets/clears the default node, scoped to the account", async () => {
  const store = await makeStore();
  const acct = await store.findOrCreateAccount("default-node@example.com");
  const hook = await store.createInboundHook(acct.id, "github_app");
  // Unset by default.
  assert.equal((await store.getInboundHook(hook.id))?.defaultNode, undefined);
  let updated = await store.setInboundHookDefaultNode(acct.id, hook.id, "macbook");
  assert.equal(updated?.defaultNode, "macbook");
  assert.equal((await store.getInboundHook(hook.id))?.defaultNode, "macbook");
  // Whitespace-only clears it (same as empty).
  updated = await store.setInboundHookDefaultNode(acct.id, hook.id, "  ");
  assert.equal(updated?.defaultNode, undefined);
  // Scoped to the owning account.
  const other = await store.findOrCreateAccount("default-node2@example.com");
  assert.equal(await store.setInboundHookDefaultNode(other.id, hook.id, "elsewhere"), undefined);
});

await test("renaming a node carries its GitHub App default-node reference along (issue #464)", async () => {
  const store = await makeStore();
  const acct = await store.findOrCreateAccount("rename-default-node@example.com");
  await store.enrollNode(acct.id, "node_a", "macbook");
  const hook = await store.createInboundHook(acct.id, "github_app");
  await store.setInboundHookDefaultNode(acct.id, hook.id, "macbook");

  // Renaming the node that the default points to must update the reference in
  // place, not leave the old name behind — otherwise the "Default node"
  // selector shows the same node twice (once under the stale saved name, once
  // under its current name from the live node list).
  const renamed = await store.setNodeName("node_a", "macbook-pro");
  assert.equal(renamed?.name, "macbook-pro");
  assert.equal((await store.getInboundHook(hook.id))?.defaultNode, "macbook-pro");

  // A default pointing at some other (non-matching) name is left untouched.
  await store.setInboundHookDefaultNode(acct.id, hook.id, "someone-elses-node");
  await store.setNodeName("node_a", "macbook-pro-2");
  assert.equal((await store.getInboundHook(hook.id))?.defaultNode, "someone-elses-node");

  // Only hooks on the same account are touched.
  await store.setInboundHookDefaultNode(acct.id, hook.id, "macbook-pro-2");
  const other = await store.findOrCreateAccount("rename-default-node2@example.com");
  await store.enrollNode(other.id, "node_b", "macbook-pro-2");
  const otherHook = await store.createInboundHook(other.id, "github_app");
  await store.setInboundHookDefaultNode(other.id, otherHook.id, "macbook-pro-2");
  await store.setNodeName("node_a", "macbook-pro-3");
  assert.equal((await store.getInboundHook(hook.id))?.defaultNode, "macbook-pro-3");
  assert.equal((await store.getInboundHook(otherHook.id))?.defaultNode, "macbook-pro-2");
});

await test("deleteInboundHook removes the hook, scoped to the account (disconnect)", async () => {
  const store = await makeStore();
  const acct = await store.findOrCreateAccount("dc@example.com");
  const hook = await store.createInboundHook(acct.id, "github_app");
  // Another account cannot delete it.
  const other = await store.findOrCreateAccount("dc2@example.com");
  assert.equal(await store.deleteInboundHook(other.id, hook.id), false);
  assert.equal((await store.getGithubAppHook(acct.id))?.id, hook.id);
  // The owner can; afterwards it's gone.
  assert.equal(await store.deleteInboundHook(acct.id, hook.id), true);
  assert.equal(await store.getGithubAppHook(acct.id), undefined);
  assert.equal(await store.getInboundHook(hook.id), undefined);
  // Idempotent: deleting again is a no-op.
  assert.equal(await store.deleteInboundHook(acct.id, hook.id), false);
});

await test("getGithubAppHook prefers a completed hook; deleteGithubAppHooks removes all (incl. orphans)", async () => {
  const store = await makeStore();
  const acct = await store.findOrCreateAccount("orphan@example.com");
  // A completed app (mention registered)…
  const real = await store.createInboundHook(acct.id, "github_app");
  await store.setInboundHookAppMeta(acct.id, real.id, { mention: "bivy-real", name: "Bivy Real" });
  // …then an abandoned create flow leaves a newer, metadata-less orphan.
  const orphan = await store.createInboundHook(acct.id, "github_app");
  // Despite being newer, the orphan must not win — the completed hook does.
  assert.equal((await store.getGithubAppHook(acct.id))?.id, real.id);
  // Disconnect removes BOTH (so nothing resurfaces as "connected").
  assert.equal(await store.deleteGithubAppHooks(acct.id), 2);
  assert.equal(await store.getGithubAppHook(acct.id), undefined);
  assert.equal(await store.getInboundHook(orphan.id), undefined);
});

// A private GitHub App only installs on the account that owns it, so covering a
// personal account plus organizations takes one app each. Every app gets its own
// hook: the hook's secret is what GitHub signs that app's deliveries with, and
// the hook is how an inbound delivery identifies which key should mint the token.
await test("an account can hold several GitHub Apps, each addressable by app id", async () => {
  const store = await makeStore();
  const acct = await store.findOrCreateAccount("multi@example.com");

  const personal = await store.createInboundHook(acct.id, "github_app");
  await store.setInboundHookAppMeta(acct.id, personal.id, { mention: "bivy-me", name: "Bivy Personal", appId: "100" });
  const org = await store.createInboundHook(acct.id, "github_app");
  await store.setInboundHookAppMeta(acct.id, org.id, { mention: "bivy-acme", name: "Bivy Acme", appId: "200" });

  const all = await store.listGithubAppHooks(acct.id);
  assert.equal(all.length, 2);
  assert.deepEqual(all.map((h) => h.appId).sort(), ["100", "200"]);

  // Addressing by app id must return that app's own hook — handing back the
  // wrong one would make the node verify deliveries with the wrong secret.
  assert.equal((await store.getGithubAppHook(acct.id, "100"))?.id, personal.id);
  assert.equal((await store.getGithubAppHook(acct.id, "200"))?.id, org.id);
  assert.equal(await store.getGithubAppHook(acct.id, "999"), undefined);

  // Each app keeps its own mention handle, so a mention of one can't fire the other.
  assert.equal((await store.getGithubAppHook(acct.id, "100"))?.botMention, "bivy-me");
  assert.equal((await store.getGithubAppHook(acct.id, "200"))?.botMention, "bivy-acme");
});

await test("disconnecting one app leaves the account's other apps connected", async () => {
  const store = await makeStore();
  const acct = await store.findOrCreateAccount("multi-disconnect@example.com");
  const personal = await store.createInboundHook(acct.id, "github_app");
  await store.setInboundHookAppMeta(acct.id, personal.id, { mention: "bivy-me", appId: "100" });
  const org = await store.createInboundHook(acct.id, "github_app");
  await store.setInboundHookAppMeta(acct.id, org.id, { mention: "bivy-acme", appId: "200" });

  assert.equal(await store.deleteGithubAppHooksForApp(acct.id, "100"), 1);
  const left = await store.listGithubAppHooks(acct.id);
  assert.deepEqual(left.map((h) => h.appId), ["200"]);
  assert.equal(await store.getInboundHook(personal.id), undefined);

  // Removing an app that isn't there is a no-op, not an error.
  assert.equal(await store.deleteGithubAppHooksForApp(acct.id, "100"), 0);

  // A foreign account cannot disconnect this account's app.
  const other = await store.findOrCreateAccount("multi-disconnect2@example.com");
  assert.equal(await store.deleteGithubAppHooksForApp(other.id, "200"), 0);
  assert.equal((await store.listGithubAppHooks(acct.id)).length, 1);
});

// The node may hold several apps' keys, so a work item has to say which app's
// installation it belongs to — otherwise the node has to guess which key to mint with.
await test("work items carry the app id of the hook that received the delivery", async () => {
  const store = await makeStore();
  const acct = await store.findOrCreateAccount("workitem-app@example.com");
  const item = await store.enqueueWorkItem(acct.id, {
    label: "bivy",
    source: "github:issue",
    title: "Fix it",
    repo: "acme/widgets",
    issueNumber: 7,
    installationId: "555",
    appId: "200",
  });
  assert.equal(item.appId, "200");
  assert.equal(item.installationId, "555");
  const pending = await store.listPendingWorkItems(acct.id, ["bivy"]);
  assert.equal(pending[0]?.appId, "200", "app id must survive the round trip to the node");
});

await test("listWorkItems returns all the account's items regardless of status", async () => {
  const store = await makeStore();
  const acct = await store.findOrCreateAccount("q@example.com");
  const a = await store.enqueueWorkItem(acct.id, { source: "github:issue", title: "first", label: "bivy" });
  const b = await store.enqueueWorkItem(acct.id, { source: "github:comment", title: "second", label: "bivy" });
  await store.claimWorkItem(acct.id, "node1", b.id); // claimed items still appear
  const items = await store.listWorkItems(acct.id);
  assert.equal(items.length, 2);
  // Both present; the claimed one keeps its status (pending items also listed).
  assert.equal(items.find((w) => w.id === b.id)?.status, "claimed");
  assert.equal(items.find((w) => w.id === a.id)?.status, "pending");
  // Account-scoped.
  const other = await store.findOrCreateAccount("q2@example.com");
  assert.equal((await store.listWorkItems(other.id)).length, 0);
});

console.log(`\nAll ${passed} control-plane store tests passed.`);
