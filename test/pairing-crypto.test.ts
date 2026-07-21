import assert from "node:assert/strict";
import {
  generatePairingKeypair,
  generateRoomKey,
  generatePairSecret,
  deriveWrapKey,
  pairingProof,
  verifyPairingProof,
  wrapRoomKey,
  unwrapRoomKey,
} from "../src/pairing-crypto.js";

/**
 * Unit tests for the X25519 pairing handshake crypto. Simulates the node and a
 * device (phone) entirely in-process — no relay/browser — to verify the key
 * agreement, proof binding, and room-key wrapping are correct and symmetric.
 */

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

await test("ECDH wrap keys match on both ends (symmetric)", () => {
  const node = generatePairingKeypair();
  const device = generatePairingKeypair();
  const fromNode = deriveWrapKey(node.privateKeyB64, device.publicKeyB64, "pair");
  const fromDevice = deriveWrapKey(device.privateKeyB64, node.publicKeyB64, "pair");
  assert.equal(fromNode.length, 32);
  assert.ok(fromNode.equals(fromDevice));
});

await test("pair and rotate purposes derive different keys", () => {
  const node = generatePairingKeypair();
  const device = generatePairingKeypair();
  const pair = deriveWrapKey(node.privateKeyB64, device.publicKeyB64, "pair");
  const rotate = deriveWrapKey(node.privateKeyB64, device.publicKeyB64, "rotate");
  assert.ok(!pair.equals(rotate));
});

await test("a different device derives a different wrap key", () => {
  const node = generatePairingKeypair();
  const deviceA = generatePairingKeypair();
  const deviceB = generatePairingKeypair();
  const a = deriveWrapKey(node.privateKeyB64, deviceA.publicKeyB64, "pair");
  const b = deriveWrapKey(node.privateKeyB64, deviceB.publicKeyB64, "pair");
  assert.ok(!a.equals(b));
});

await test("pairing proof verifies and rejects tampering", () => {
  const secret = generatePairSecret();
  const device = generatePairingKeypair();
  const proof = pairingProof(secret, device.publicKeyB64);
  assert.ok(verifyPairingProof(secret, device.publicKeyB64, proof));
  // Wrong secret (e.g. a relay that never saw the QR) cannot forge it.
  assert.ok(!verifyPairingProof(generatePairSecret(), device.publicKeyB64, proof));
  // Substituted public key fails the bound proof.
  const other = generatePairingKeypair();
  assert.ok(!verifyPairingProof(secret, other.publicKeyB64, proof));
});

await test("room key wraps and unwraps across the ECDH-derived key", () => {
  const node = generatePairingKeypair();
  const device = generatePairingKeypair();
  const roomKey = generateRoomKey();
  // Node side: derive wrap key against the device's public key, wrap.
  const nodeWrap = deriveWrapKey(node.privateKeyB64, device.publicKeyB64, "pair");
  const wrapped = wrapRoomKey(nodeWrap, roomKey);
  // Device side: derive the same wrap key against the node's public key, unwrap.
  const deviceWrap = deriveWrapKey(device.privateKeyB64, node.publicKeyB64, "pair");
  const unwrapped = unwrapRoomKey(deviceWrap, wrapped);
  assert.ok(unwrapped.equals(roomKey));
});

await test("full pairing then key rotation (revoke-other) round-trips", () => {
  const node = generatePairingKeypair();
  const device = generatePairingKeypair();
  // Pairing: deliver room key v1.
  const roomV1 = generateRoomKey();
  const w1 = wrapRoomKey(deriveWrapKey(node.privateKeyB64, device.publicKeyB64, "pair"), roomV1);
  assert.ok(unwrapRoomKey(deriveWrapKey(device.privateKeyB64, node.publicKeyB64, "pair"), w1).equals(roomV1));
  // Another device revoked → node rotates to room key v2 and re-wraps for this
  // device using the stored public key (rotate purpose, no re-scan needed).
  const roomV2 = generateRoomKey();
  const w2 = wrapRoomKey(deriveWrapKey(node.privateKeyB64, device.publicKeyB64, "rotate"), roomV2);
  const got = unwrapRoomKey(deriveWrapKey(device.privateKeyB64, node.publicKeyB64, "rotate"), w2);
  assert.ok(got.equals(roomV2));
  assert.ok(!got.equals(roomV1));
});

console.log(`\nAll ${passed} pairing-crypto tests passed.`);
