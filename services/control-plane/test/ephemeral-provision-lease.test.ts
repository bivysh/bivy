// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
process.env.HOSTED_CREDENTIAL_KEY = Buffer.alloc(32, 7).toString("base64");
delete process.env.EPHEMERAL_MACHINES_ENABLED;
import { createPgMemStore } from "../src/pg-mem-store.js";
import { maybeAutoProvision } from "../src/ephemeral-provisioner.js";
import { providerCredentialFingerprint } from "../src/store.js";
import type { EphemeralMachine } from "@bivy/core";

const store = createPgMemStore();
await store.init();
const account = await store.findOrCreateAccount("provision-lease@example.com");
const config = { id: "cfg1", name: "Hosted", provider: "fly", ttlMinutes: 15, createdAt: "", updatedAt: "" };
await store.setEphemeralConfigs(account.id, [config]);
await store.setQueueRouting(account.id, { primary: { kind: "config", configId: config.id } });
await store.setHostedProvisioning(account.id, {
  enabled: true,
  providerTokens: { fly: "fly-token" },
  validatedProviders: { fly: providerCredentialFingerprint("fly-token") },
});

let launches = 0;
const launcher = async (_opts: unknown, deps: { machines: { add: (machine: EphemeralMachine) => Promise<EphemeralMachine> } }): Promise<EphemeralMachine> => {
  launches++;
  await new Promise((resolve) => setTimeout(resolve, 30));
  const machine = { id: `machine-${launches}`, provider: "fly", name: "Hosted", region: "iad", status: "starting", ip: null, createdAt: new Date().toISOString(), nodeId: `eph-${launches}` } as EphemeralMachine;
  await deps.machines.add(machine);
  return machine;
};
const env = { cpBaseUrl: "https://cp.example", relayUrl: "wss://relay.example" };
const results = await Promise.all([
  maybeAutoProvision(store, account.id, env, launcher as never),
  maybeAutoProvision(store, account.id, env, launcher as never),
]);
assert.equal(launches, 1, "concurrent decisions must create only one paid machine");
assert.equal(results.filter(Boolean).length, 1, "only the lease holder returns a machine");

const holder = "crashed-worker";
assert.equal(await store.acquireHostedProvisionLease(account.id, holder, 30), true);
assert.equal(await store.acquireHostedProvisionLease(account.id, "other-worker", 30), false, "an unexpired lease excludes another worker");
await store.releaseHostedProvisionLease(account.id, "wrong-holder");
assert.equal(await store.acquireHostedProvisionLease(account.id, "other-worker", 30), false, "only the holder may release its lease");
await store.releaseHostedProvisionLease(account.id, holder);
assert.equal(await store.acquireHostedProvisionLease(account.id, "other-worker", 30), true, "release makes the account claimable again");
console.log("✓ hosted provision lease prevents duplicate paid launches");
