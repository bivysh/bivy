// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
process.env.HOSTED_CREDENTIAL_KEY = Buffer.alloc(32, 7).toString("base64");
delete process.env.EPHEMERAL_MACHINES_ENABLED;
import { createPgMemStore } from "../src/pg-mem-store.js";
import { ensureReadyCapacity, maybeAutoProvision } from "../src/ephemeral-provisioner.js";
import { providerCredentialFingerprint } from "../src/store.js";
import type { EphemeralMachine } from "@bivy/core";

const store = createPgMemStore();
await store.init();
const account = await store.findOrCreateAccount("ready-capacity@example.com");
const config = { id: "cfg-ready", name: "Ready", provider: "hetzner", readyCapacity: 1, ttlMinutes: 15, createdAt: "", updatedAt: "" };
await store.setEphemeralConfigs(account.id, [config]);
await store.setQueueRouting(account.id, { primary: { kind: "config", configId: config.id } });
await store.setHostedProvisioning(account.id, {
  enabled: true,
  providerTokens: { hetzner: "token" },
  validatedProviders: { hetzner: providerCredentialFingerprint("token") },
});

let launches = 0;
let purpose: unknown;
const launcher = async (opts: Record<string, unknown>, deps: { machines: { add: (machine: EphemeralMachine) => Promise<EphemeralMachine> } }): Promise<EphemeralMachine> => {
  launches++;
  purpose = opts.purpose;
  const machine = { id: "machine-ready", provider: "hetzner", name: "Ready", region: "fsn1", status: "running", ip: null, createdAt: new Date().toISOString(), nodeId: "eph-ready", setupId: config.id, purpose: opts.purpose } as EphemeralMachine;
  await deps.machines.add(machine);
  return machine;
};
const env = { cpBaseUrl: "https://cp.example", relayUrl: "wss://relay.example" };
await ensureReadyCapacity(store, account.id, env, launcher as never);
await ensureReadyCapacity(store, account.id, env, launcher as never);
assert.equal(launches, 1, "reconciliation must keep exactly the requested capacity");
assert.equal(purpose, "ready-capacity");

const machines = await store.getHostedMachines(account.id);
await store.setHostedMachines(account.id, machines.map((m) => ({ ...m, milestones: { nodeReadyAt: new Date().toISOString() } })));
const work = await store.enqueueWorkItem(account.id, { source: "manual", title: "claim ready" });
const claimed = await maybeAutoProvision(store, account.id, env, (async () => { throw new Error("must not launch on ready claim"); }) as never);
assert.equal(claimed?.nodeId, "eph-ready");
assert.equal(claimed?.purpose, "queue-default");
const routed = (await store.listWorkItems(account.id, 10)).find((item) => item.id === work.id);
assert.equal(routed?.label, "bivy/ready", "claim routes waiting work without provider boot");
const audit = await store.listHostedAudit(account.id, 20);
assert.ok(audit.some((event) => event.action === "capacity_ready"));
assert.ok(audit.some((event) => event.action === "capacity_claimed"));
console.log("✓ account-owned ready capacity reconciles once and claims without provider launch");
