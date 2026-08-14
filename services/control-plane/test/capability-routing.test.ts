// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { createPgMemStore } from "../src/pg-mem-store.js";
import { gatherPreflightSignals, type PreflightSignalContext } from "../src/automation-match.js";
import { runPreflightChecks } from "@bivy/automation-core";

/**
 * Capability-tag routing at the store layer: a node's self-declared
 * capabilities gate/inform required and preferred capability requests on
 * work items and automation definitions. See @bivy/core's
 * capability-routing.ts for the pure matcher this builds on.
 */

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

await test("setNodeCapabilities persists and round-trips through listNodes", async () => {
  const store = await makeStore();
  const account = await store.findOrCreateAccount("cap-a@example.com");
  const { node } = await store.enrollNode(account.id, "node-gpu", "GPU Box");
  assert.deepEqual((await store.listNodes(account.id))[0]?.capabilities, undefined);

  await store.setNodeCapabilities(node.id, ["gpu", "docker"]);
  const [listed] = await store.listNodes(account.id);
  assert.deepEqual(listed?.capabilities, ["gpu", "docker"]);

  // Overwritten wholesale, not merged, on the next declaration.
  await store.setNodeCapabilities(node.id, ["docker"]);
  assert.deepEqual((await store.listNodes(account.id))[0]?.capabilities, ["docker"]);
});

await test("required capability: parks honestly (needs_attention) when no machine anywhere has ever declared it", async () => {
  const store = await makeStore();
  const account = await store.findOrCreateAccount("cap-b@example.com");
  await store.enrollNode(account.id, "node-plain", "Laptop"); // no capabilities declared

  const run = await store.enqueueAutomationRun(account.id, {
    source: "manual",
    title: "needs a GPU",
    requiredCapabilities: ["gpu"],
  });
  assert.equal(run.status, "needs_attention");
  assert.equal(run.routingReason, "no machine declares required capability: gpu");
  // The explanation is bounded, privacy-safe: no URLs, secrets, or command text.
  assert.ok(!/https?:\/\//.test(run.routingReason ?? ""));
  assert.ok((run.routingReason ?? "").length <= 200);
});

await test("required capability: an OFFLINE machine that declared it still counts — queues honestly instead of parking", async () => {
  const store = await makeStore();
  const account = await store.findOrCreateAccount("cap-c@example.com");
  const { node } = await store.enrollNode(account.id, "node-gpu", "GPU Box");
  await store.setNodeCapabilities(node.id, ["gpu"]);
  await store.setNodeOnline(node.id, false); // never came online / went offline

  const run = await store.enqueueAutomationRun(account.id, {
    source: "manual",
    title: "needs a GPU",
    requiredCapabilities: ["gpu"],
  });
  // A stale/offline declaration is still an honest reason to wait, not park —
  // tags are assertions, never re-verified, so an offline machine's prior
  // assertion is treated exactly like a fresh one.
  assert.equal(run.status, "pending");
  assert.equal(run.routingReason, undefined);
});

await test("required capability: an ONLINE eligible machine also queues normally (pending, not parked)", async () => {
  const store = await makeStore();
  const account = await store.findOrCreateAccount("cap-d@example.com");
  const { node } = await store.enrollNode(account.id, "node-gpu", "GPU Box");
  await store.setNodeCapabilities(node.id, ["gpu", "docker"]);
  await store.setNodeOnline(node.id, true);

  const run = await store.enqueueAutomationRun(account.id, {
    source: "manual",
    title: "needs a GPU",
    requiredCapabilities: ["gpu"],
  });
  assert.equal(run.status, "pending");
});

await test("preferred capability: never blocks or parks, even when nothing matches it", async () => {
  const store = await makeStore();
  const account = await store.findOrCreateAccount("cap-e@example.com");
  await store.enrollNode(account.id, "node-plain", "Laptop"); // no capabilities

  const run = await store.enqueueAutomationRun(account.id, {
    source: "manual",
    title: "prefers a GPU but doesn't need one",
    preferredCapabilities: ["gpu"],
  });
  assert.equal(run.status, "pending");
  assert.equal(run.routingReason, undefined);
});

await test("an AutomationDefinition's required/preferred capabilities are inherited by a run that doesn't override them", async () => {
  const store = await makeStore();
  const account = await store.findOrCreateAccount("cap-f@example.com");
  await store.enrollNode(account.id, "node-plain", "Laptop");

  const definition = await store.createAutomationDefinition(account.id, {
    name: "gpu-job",
    trigger: "manual",
    enabled: true,
    requiredCapabilities: ["gpu"],
    preferredCapabilities: ["docker"],
  });
  assert.deepEqual(definition.requiredCapabilities, ["gpu"]);
  assert.deepEqual(definition.preferredCapabilities, ["docker"]);

  const run = await store.enqueueAutomationRun(account.id, {
    source: "manual",
    title: "run it",
    definitionId: definition.id,
  });
  assert.equal(run.status, "needs_attention", "no machine declares gpu, so the inherited requirement still parks honestly");
  assert.equal(run.routingReason, "no machine declares required capability: gpu");

  // An explicit per-run override wins over the definition's requirement.
  await store.enrollNode(account.id, "node-gpu", "GPU Box").then(({ node }) => store.setNodeCapabilities(node.id, ["gpu"]));
  const overridden = await store.enqueueAutomationRun(account.id, {
    source: "manual",
    title: "run it, no requirement this time",
    definitionId: definition.id,
    requiredCapabilities: [],
  });
  // An explicit empty array is falsy-length, so it does NOT fall back to the
  // definition's requirement — the override is honored as "no requirement."
  assert.equal(overridden.status, "pending");
});

await test("updateAutomationDefinition can change and clear required/preferred capabilities", async () => {
  const store = await makeStore();
  const account = await store.findOrCreateAccount("cap-g@example.com");
  const definition = await store.createAutomationDefinition(account.id, {
    name: "job",
    trigger: "manual",
    enabled: true,
    requiredCapabilities: ["gpu"],
  });
  const updated = await store.updateAutomationDefinition(account.id, definition.id, { requiredCapabilities: ["docker", "gpu"], preferredCapabilities: ["private-net"] });
  assert.deepEqual(updated?.requiredCapabilities, ["docker", "gpu"]);
  assert.deepEqual(updated?.preferredCapabilities, ["private-net"]);

  const cleared = await store.updateAutomationDefinition(account.id, definition.id, { requiredCapabilities: undefined });
  assert.deepEqual(cleared?.requiredCapabilities, undefined);
});

await test("preflight: capabilityGap takes priority over an online machine — 'online but lacking the tag' is reported honestly", async () => {
  const store = await makeStore();
  const account = await store.findOrCreateAccount("cap-h@example.com");
  const { node } = await store.enrollNode(account.id, "node-plain", "laptop");
  await store.setNodeOnline(node.id, true); // online, but never declared "gpu"

  const ctx: PreflightSignalContext = {
    hooks: [],
    nodes: await store.listNodes(account.id),
    allowance: { used: 0, warn: false, exhausted: false },
  };
  const signals = gatherPreflightSignals(
    { trigger: "manual", requiredCapabilities: ["gpu"] },
    ctx,
  );
  assert.deepEqual(signals.assignedMachine?.capabilityGap, ["gpu"]);
  assert.equal(signals.assignedMachine?.primaryOnline, true, "the machine really is online");

  const results = runPreflightChecks(signals);
  const machineCheck = results.find((r) => r.id === "assigned_machine");
  assert.equal(machineCheck?.severity, "warn");
  assert.match(machineCheck?.detail ?? "", /required capability: gpu/);
  assert.equal(machineCheck?.blocksSave, false, "capability gaps are informational, not a hard save-blocker");
});

await test("preflight: no capability gap once a declared machine exists, even offline", async () => {
  const store = await makeStore();
  const account = await store.findOrCreateAccount("cap-i@example.com");
  const { node } = await store.enrollNode(account.id, "node-gpu", "gpu-box");
  await store.setNodeCapabilities(node.id, ["gpu"]);
  await store.setNodeOnline(node.id, false);

  const ctx: PreflightSignalContext = {
    hooks: [],
    nodes: await store.listNodes(account.id),
    allowance: { used: 0, warn: false, exhausted: false },
  };
  const signals = gatherPreflightSignals({ trigger: "manual", requiredCapabilities: ["gpu"] }, ctx);
  assert.equal(signals.assignedMachine?.capabilityGap, undefined);
});

console.log(`\n${passed} capability-routing test(s) passed`);
