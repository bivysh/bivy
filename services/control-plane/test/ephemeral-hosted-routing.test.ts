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
const account = await store.findOrCreateAccount("hosted-routing@example.com");
const config = { id: "cfg1", name: "Hosted", provider: "fly", region: "iad", ttlMinutes: 15, createdAt: "", updatedAt: "" };
await store.setEphemeralConfigs(account.id, [config]);
await store.setQueueRouting(account.id, { primary: { kind: "config", configId: config.id } });
await store.setHostedProvisioning(account.id, {
  enabled: true,
  providerTokens: { fly: "fly-token" },
  validatedProviders: { fly: providerCredentialFingerprint("fly-token") },
});
const waiting = await store.enqueueWorkItem(account.id, { source: "manual", title: "run me" });
const explicit = await store.enqueueWorkItem(account.id, { source: "manual", title: "leave me", label: "bivy/other-node" });

const launcher = async (): Promise<EphemeralMachine> => ({
  id: "machine-1", provider: "fly", name: "Hosted", region: "iad", status: "starting", ip: null,
  createdAt: new Date().toISOString(), nodeId: "eph-ab12cd34",
});
const machine = await maybeAutoProvision(store, account.id, { cpBaseUrl: "https://cp.example", relayUrl: "wss://relay.example" }, launcher as never);
assert.equal(machine?.nodeId, "eph-ab12cd34");
const items = await store.listWorkItems(account.id, 10);
assert.equal(items.find((item) => item.id === waiting.id)?.label, "bivy/ab12cd34", "shared work must move to the launched runner");
assert.equal(items.find((item) => item.id === waiting.id)?.ephemeral, true, "routed work is marked ephemeral");
assert.equal(items.find((item) => item.id === explicit.id)?.label, "bivy/other-node", "explicit work for another node must not move");
const audit = await store.listHostedAudit(account.id, 20);
assert.ok(audit.some((event) => event.action === "work_routed" && event.workItemId === waiting.id), "routing decision must be audited");
console.log("✓ hosted provision routes triggering shared work to its unique runner label");
