import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PairingStore } from "../src/device-registry.js";
import {
  generatePairingKeypair,
  pairingProof,
  deriveWrapKey,
  unwrapRoomKey,
} from "../src/pairing-crypto.js";

/**
 * Integration test for the node-side pairing registry: simulates a device (the
 * phone) using only the pairing-crypto primitives and exercises the full
 * handshake, persistence, and per-device revocation via room-key rotation.
 */

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bivy-pair-"));
}

// Simulate a device completing the handshake; returns its keypair + the room key
// it unwrapped from the welcome.
function pairDevice(store: PairingStore) {
  const device = generatePairingKeypair();
  const secret = store.issuePairSecret();
  const proofB64 = pairingProof(secret, device.publicKeyB64);
  const welcome = store.handleHello({ devicePublicKeyB64: device.publicKeyB64, proofB64, label: "Phone" });
  assert.ok(welcome, "handshake should succeed with a valid proof");
  const wrapKey = deriveWrapKey(device.privateKeyB64, welcome!.nodePublicKeyB64, "pair");
  const roomKey = unwrapRoomKey(wrapKey, welcome!.wrapped);
  return { device, deviceId: welcome!.deviceId, roomKey };
}

await test("a valid handshake delivers the current room key", () => {
  const store = PairingStore.load(tmpDir());
  const { roomKey } = pairDevice(store);
  assert.ok(roomKey.equals(store.roomKey()));
});

await test("a hello without a valid proof is rejected", () => {
  const store = PairingStore.load(tmpDir());
  const device = generatePairingKeypair();
  store.issuePairSecret();
  // Proof keyed by a secret the (malicious) caller never received from the QR.
  const forged = pairingProof(generatePairingKeypair().privateKeyB64.slice(0, 43), device.publicKeyB64);
  assert.equal(store.handleHello({ devicePublicKeyB64: device.publicKeyB64, proofB64: forged }), null);
});

await test("a pairing secret is single-use", () => {
  const store = PairingStore.load(tmpDir());
  const device = generatePairingKeypair();
  const secret = store.issuePairSecret();
  const proofB64 = pairingProof(secret, device.publicKeyB64);
  assert.ok(store.handleHello({ devicePublicKeyB64: device.publicKeyB64, proofB64 }));
  // Re-using the same secret (e.g. a replayed hello) fails.
  const device2 = generatePairingKeypair();
  assert.equal(store.handleHello({ devicePublicKeyB64: device2.publicKeyB64, proofB64: pairingProof(secret, device2.publicKeyB64) }), null);
});

await test("revoking a device rotates the key and re-wraps for survivors", () => {
  const store = PairingStore.load(tmpDir());
  const a = pairDevice(store);
  const b = pairDevice(store);
  assert.equal(store.listDevices().length, 2);
  const oldRoom = store.roomKey();
  assert.ok(a.roomKey.equals(oldRoom) && b.roomKey.equals(oldRoom));

  const deliveries = store.revokeDevice(a.deviceId);
  assert.ok(deliveries, "revoke returns rotation deliveries");
  assert.equal(store.listDevices().length, 1);
  const newRoom = store.roomKey();
  assert.ok(!newRoom.equals(oldRoom), "room key rotated");

  // Surviving device B can unwrap the new room key from its rotate delivery.
  const mine = deliveries!.find((d) => d.deviceId === b.deviceId);
  assert.ok(mine, "a delivery exists for the surviving device");
  const bRotateKey = deriveWrapKey(b.device.privateKeyB64, store.nodePublicKeyB64(), "rotate");
  assert.ok(unwrapRoomKey(bRotateKey, mine!.wrapped).equals(newRoom));

  // The revoked device gets no delivery and its old key is dead.
  assert.equal(deliveries!.find((d) => d.deviceId === a.deviceId), undefined);
});

await test("state persists across reload (keypair, room key, devices)", () => {
  const dir = tmpDir();
  const store = PairingStore.load(dir);
  const { deviceId } = pairDevice(store);
  const pub = store.nodePublicKeyB64();
  const room = store.roomKey().toString("base64");

  const reloaded = PairingStore.load(dir);
  assert.equal(reloaded.nodePublicKeyB64(), pub);
  assert.equal(reloaded.roomKey().toString("base64"), room);
  assert.ok(reloaded.listDevices().some((d) => d.id === deviceId));
});

await test("a fresh store generates a random room key (no static seed)", () => {
  // The legacy relay.json e2eKey seed was retired: a brand-new store
  // always mints a random room key; devices receive it over the X25519 handshake.
  const a = PairingStore.load(tmpDir()).roomKey();
  const b = PairingStore.load(tmpDir()).roomKey();
  assert.equal(a.length, 32);
  assert.ok(!a.equals(b), "two fresh stores get independent room keys");
});

await test("a corrupt pairing.json throws instead of silently regenerating", () => {
  const dir = tmpDir();
  const file = path.join(dir, "pairing.json");
  fs.writeFileSync(file, "{not valid json");
  assert.throws(() => PairingStore.load(dir), /corrupt/i);
  // The corrupt file must be left exactly as-is — no regeneration attempt.
  assert.equal(fs.readFileSync(file, "utf8"), "{not valid json");
});

await test("a pairing.json missing required fields throws instead of silently regenerating", () => {
  const dir = tmpDir();
  const file = path.join(dir, "pairing.json");
  fs.writeFileSync(file, JSON.stringify({ devices: [] }));
  assert.throws(() => PairingStore.load(dir), /missing required fields/i);
});

await test("a missing pairing.json is the normal first-run case (no throw)", () => {
  assert.doesNotThrow(() => PairingStore.load(tmpDir()));
});

await test("persist() writes atomically: no leftover .tmp file, dir is private", () => {
  const dir = tmpDir();
  const store = PairingStore.load(dir);
  pairDevice(store);
  assert.ok(fs.existsSync(path.join(dir, "pairing.json")));
  assert.equal(fs.existsSync(path.join(dir, "pairing.json.tmp")), false);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700, "data dir should be created with mode 0700");
    assert.equal(fs.statSync(path.join(dir, "pairing.json")).mode & 0o777, 0o600);
  }
});

console.log(`\nAll ${passed} device-registry tests passed.`);
