// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
//
// Gap 3: a HOSTED (device-offline) rebuild needs the session room key server-side.
// The control plane escrows it — sealed at rest with the per-account hosted key —
// keyed by the reusable node id, surviving teardown, and hands it back to the
// machine it re-launches (never decrypting the snapshot itself).
import assert from "node:assert/strict";
// Must be set before any hosted-crypto encrypt/decrypt runs (read per-call).
process.env.HOSTED_CREDENTIAL_KEY = Buffer.alloc(32, 7).toString("base64");
import { createPgMemStore } from "../src/pg-mem-store.js";
import { provisionEphemeralForAccount, provisionEphemeralRestore, type ProvisionEnv } from "../src/ephemeral-provisioner.js";
import { decryptSecret } from "../src/hosted-crypto.js";
import type { EphemeralMachine } from "@bivy/core";

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

const ENV: ProvisionEnv = { cpBaseUrl: "https://cp.example", relayUrl: "wss://relay.example" };
const CONFIG = { id: "cfg1", name: "Hosted", provider: "fly", region: "iad", ttlMinutes: 60, createdAt: "", updatedAt: "" };
const ROOM_KEY = Buffer.alloc(32, 9).toString("base64");

await test("store escrow round-trips and SURVIVES node unenroll", async () => {
  const store = await makeStore();
  const acct = await store.findOrCreateAccount("a@example.com");
  await store.enrollNode(acct.id, "eph-1", "Ephemeral");
  await store.setNodeRoomKeyEnc(acct.id, "eph-1", { v: 1, kid: "k1", iv: "aa", ct: "bb", tag: "cc" });
  await store.removeNode(acct.id, "eph-1"); // teardown unenrolls the node
  const got = await store.getNodeRoomKeyEnc(acct.id, "eph-1");
  assert.ok(got, "escrowed room key must survive node removal");
  assert.equal(got?.kid, "k1");
});

await test("provisionEphemeralForAccount escrows the generated room key (hosted)", async () => {
  const store = await makeStore();
  const acct = await store.findOrCreateAccount("b@example.com");
  await store.setHostedProvisioning(acct.id, { enabled: true, providerTokens: { fly: "fly-token" } });
  const launcher = async (opts: Record<string, unknown>, deps: { store: { addKey: (id: string, key: string) => void } }): Promise<EphemeralMachine> => {
    const nodeId = (opts.reuseNodeId as string) || "eph-new";
    deps.store.addKey(nodeId, ROOM_KEY); // what the real launcher does on room-key mint
    return { id: "m1", provider: "fly", name: "x", region: "iad", status: "running", ip: null, createdAt: "", nodeId } as EphemeralMachine;
  };
  const machine = await provisionEphemeralForAccount(store, acct.id, CONFIG, ENV, launcher as never);
  const enc = await store.getNodeRoomKeyEnc(acct.id, machine.nodeId!);
  assert.ok(enc, "room key must be escrowed after a hosted launch");
  assert.equal(decryptSecret(acct.id, enc!), ROOM_KEY, "escrow must decrypt back to the generated key");
});

await test("provisionEphemeralRestore hands the escrowed key back to the rebuilt machine", async () => {
  const store = await makeStore();
  const acct = await store.findOrCreateAccount("c@example.com");
  await store.setHostedProvisioning(acct.id, { enabled: true, providerTokens: { fly: "fly-token" } });
  // Simulate a prior hosted launch that escrowed the room key for eph-42.
  const launch = async (opts: Record<string, unknown>, deps: { store: { addKey: (id: string, key: string) => void } }): Promise<EphemeralMachine> => {
    deps.store.addKey("eph-42", ROOM_KEY);
    return { id: "m0", provider: "fly", name: "x", region: "iad", status: "running", ip: null, createdAt: "", nodeId: "eph-42" } as EphemeralMachine;
  };
  await provisionEphemeralForAccount(store, acct.id, CONFIG, ENV, launch as never);

  // Now rebuild that session server-side; the launcher must receive the reused
  // node id, the decrypted room key, and the restore session id.
  let captured: Record<string, unknown> | undefined;
  const rebuildLauncher = async (opts: Record<string, unknown>): Promise<EphemeralMachine> => {
    captured = opts;
    return { id: "m1", provider: "fly", name: "x", region: "iad", status: "running", ip: null, createdAt: "", nodeId: "eph-42" } as EphemeralMachine;
  };
  await provisionEphemeralRestore(store, acct.id, CONFIG, ENV, { reuseNodeId: "eph-42", restoreSessionId: "sess-7" }, rebuildLauncher as never);
  assert.equal(captured?.reuseNodeId, "eph-42");
  assert.equal(captured?.reuseRoomKeyB64, ROOM_KEY, "must inject the decrypted escrowed key");
  assert.equal(captured?.restoreSessionId, "sess-7");
});

await test("restore fails cleanly when no room key was escrowed", async () => {
  const store = await makeStore();
  const acct = await store.findOrCreateAccount("d@example.com");
  await store.setHostedProvisioning(acct.id, { enabled: true, providerTokens: { fly: "fly-token" } });
  await assert.rejects(
    () => provisionEphemeralRestore(store, acct.id, CONFIG, ENV, { reuseNodeId: "eph-unknown", restoreSessionId: "s1" }, (async () => ({}) as EphemeralMachine) as never),
    /No escrowed room key/,
  );
});

console.log(`hosted-room-key-escrow: ${passed} test(s) passed`);
