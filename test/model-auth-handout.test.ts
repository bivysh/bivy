// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
//
// A signed-in device hands the account's vault key to a new machine: machine A
// wraps the key for the device (node crypto), the device unwraps it and wraps
// it for machine B (browser crypto, @bivy/core), and machine B opens it with
// node crypto. Both stacks must agree byte for byte for this to work.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { deriveWrapKey, generatePairingKeypair } from "../src/pairing-crypto.js";
import { open, seal } from "../src/e2e.js";
import { handOutModelAuthKey } from "../packages/core/src/model-auth-handout.js";
import { b64url } from "../packages/core/src/base64.js";

const machineA = generatePairingKeypair();
const machineB = generatePairingKeypair();
const kp = (await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
const device = { priv: kp.privateKey, pub: b64url(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey))) };
const vaultKeyB64 = randomBytes(32).toString("base64");

// What machine A stored for the device, and the request machine B left.
const forDevice = seal(deriveWrapKey(machineA.privateKeyB64, device.pub, "model-auth-vault"), vaultKeyB64);
const answers: Array<{ devicePublicKey: string; targetNodeId: string; wrappedKey: string }> = [];
const answered = await handOutModelAuthKey({
  get: async (devicePublicKey) => {
    assert.equal(devicePublicKey, device.pub);
    return { wrappedKey: { wrappedKey: forDevice, wrappedByPublicKey: machineA.publicKeyB64 }, requests: [{ nodeId: "node-b", publicKey: machineB.publicKeyB64 }] };
  },
  put: async (input) => void answers.push(input),
}, device);

assert.equal(answered, 1);
assert.equal(answers[0].targetNodeId, "node-b");
assert.ok(!answers[0].wrappedKey.includes(vaultKeyB64), "the key travels wrapped, never in the clear");
// Machine B opens it exactly as it opens a wrap from another machine: with the
// wrapper's public key, which the control plane records as the device's.
assert.equal(open(deriveWrapKey(machineB.privateKeyB64, answers[0].devicePublicKey, "model-auth-vault"), answers[0].wrappedKey), vaultKeyB64);

// A device without a copy (not wrapped for yet, or dropped by a re-key) answers nobody.
assert.equal(await handOutModelAuthKey({
  get: async () => ({ wrappedKey: null, requests: [{ nodeId: "node-b", publicKey: machineB.publicKeyB64 }] }),
  put: async () => { throw new Error("must not answer"); },
}, device), 0);

// A deployment's pool key (made by the fleet) opens a wrap one of the
// account's machines made for it, with the node's own key exchange.
{
  const { newPoolKey } = await import("../services/fleet/src/pool-key.js");
  const pool = newPoolKey();
  const wrapped = seal(deriveWrapKey(machineA.privateKeyB64, pool.publicKey, "model-auth-vault"), vaultKeyB64);
  assert.equal(open(deriveWrapKey(pool.privateKey, machineA.publicKeyB64, "model-auth-vault"), wrapped), vaultKeyB64);
}

console.log("model-auth-handout: all tests passed");
