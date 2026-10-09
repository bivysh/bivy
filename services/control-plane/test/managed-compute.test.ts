// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Deployment-supplied compute: the EPHEMERAL_MACHINES_ENABLED kill switch, the
// managed config's compute source surviving the store, and the extension
// profile cache that decides whether an account is offered a cloud computer.
import assert from "node:assert/strict";
import { createPgMemStore } from "../src/pg-mem-store.js";
import type { EphemeralNodeConfig } from "../src/store.js";
import { DeploymentCompute, managedComputeEnabled, type ComputeProfile } from "../src/deployment-compute.js";

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

await test("managedComputeEnabled: default OFF, only exact '1' enables", () => {
  assert.equal(managedComputeEnabled({} as never), false, "unset → off (default)");
  assert.equal(managedComputeEnabled({ EPHEMERAL_MACHINES_ENABLED: "1" } as never), true, "=1 → on");
  assert.equal(managedComputeEnabled({ EPHEMERAL_MACHINES_ENABLED: "0" } as never), false, "=0 → off");
  assert.equal(managedComputeEnabled({ EPHEMERAL_MACHINES_ENABLED: "true" } as never), false, "only exact '1' enables");
});

await test("computeSource survives the store round-trip; junk values are dropped", async () => {
  const store = createPgMemStore();
  await store.init();
  const account = await store.findOrCreateAccount("roundtrip@example.com");
  const managed: EphemeralNodeConfig = { id: "cfg-managed", name: "Bivy Cloud", provider: "fly", ttlMinutes: 60, computeSource: "managed", createdAt: "", updatedAt: "" };
  await store.setEphemeralConfigs(account.id, [
    managed,
    { ...managed, id: "cfg-user", computeSource: undefined },
    { ...managed, id: "cfg-junk", computeSource: "operator" as never },
  ]);
  const configs = await store.getEphemeralConfigs(account.id);
  assert.equal(configs.find((c) => c.id === "cfg-managed")?.computeSource, "managed");
  assert.equal(configs.find((c) => c.id === "cfg-user")?.computeSource, undefined);
  assert.equal(configs.find((c) => c.id === "cfg-junk")?.computeSource, undefined, "unknown value normalizes to the user lane");
});

await test("deployment profile: reused for a minute, last answer kept through an extension outage", async () => {
  let now = 0;
  let calls = 0;
  let answer: () => Promise<ComputeProfile | null> = async () => ({ provider: "fly", accountMachine: true });
  const compute = new DeploymentCompute({ profile: async () => { calls++; return answer(); } }, () => now);
  assert.equal((await compute.profile("interactive", "a"))?.accountMachine, true);
  assert.equal((await compute.profile("interactive", "a"))?.accountMachine, true);
  assert.equal(calls, 1, "a fresh answer is reused");
  now = 2 * 60_000;
  answer = async () => { throw new Error("extension down"); };
  assert.equal((await compute.profile("interactive", "a"))?.accountMachine, true, "an outage keeps the last answer");
  answer = async () => ({ provider: "" });
  assert.equal(await compute.profile("interactive", "a"), null, "a profile without a provider is no offer");
  assert.equal(await new DeploymentCompute(undefined).profile("interactive", "a"), null, "no extension → no managed lane");
});

console.log(`managed-compute: ${passed} test(s) passed`);
