// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Client half of the Bivy relay E2E handshake, for a CLI that reaches a node
// through the hosted relay (the `bivy run --node <account-node>` path).
//
// This is the SECURITY-CRITICAL core of relay tunnelling, deliberately isolated
// from the (network) transport so it can be unit-tested in-process against the
// real node-side PairingStore (see test/relay-cli-crypto.test.ts). It mirrors the
// browser client's crypto (packages/core transport-relay) using the same primitives
// the node uses, so a CLI device pairs and exchanges frames exactly like a phone.
//
// Flow (transport carries these opaque):
//   1. device keypair  = newDeviceKeypair()
//   2. hello           = buildHello(pairSecret, keypair)         → send as t:"pair"
//   3. node.handleHello(hello) → welcome                          (node side)
//   4. roomKey         = acceptWelcome(keypair, welcome)          ← recover room key
//   5. sealFrame(roomKey, msg) / openFrame(roomKey, payload)      ↔ bulk frames
//
// The pairSecret comes OUT OF BAND (a `bivy link`-style QR/token from the target
// node); the relay never sees it, so it can route frames but never derive the
// room key. See docs/relay-node-cli.md for the full transport design.

import {
  generatePairingKeypair,
  pairingProof,
  deriveWrapKey,
  unwrapRoomKey,
  type PairingKeypair,
} from "./pairing-crypto.js";
import { sealFrame, openFrame, type Frame } from "./e2e.js";

export type PairHello = { k: "pair.hello"; devicePublicKeyB64: string; proofB64: string; label?: string };
export type PairWelcomeMsg = { nodePublicKeyB64: string; wrapped: string };

/** A fresh device identity for this CLI (persist privateKeyB64 to reuse a pairing). */
export function newDeviceKeypair(): PairingKeypair {
  return generatePairingKeypair();
}

/**
 * Build the `pair.hello` payload proving knowledge of the out-of-band pairing
 * secret without ever sending it. `label` shows up in the node's device list.
 */
export function buildHello(pairSecretB64: string, keypair: PairingKeypair, label = "Bivy CLI"): PairHello {
  return {
    k: "pair.hello",
    devicePublicKeyB64: keypair.publicKeyB64,
    proofB64: pairingProof(pairSecretB64, keypair.publicKeyB64),
    label,
  };
}

/**
 * Recover the shared room key from the node's `pair.welcome`. Derives the same
 * ECDH wrap key the node used (ECDH is symmetric) and unwraps the room key.
 * Throws if the welcome is malformed or the wrap doesn't open (wrong node/key).
 */
export function acceptWelcome(keypair: PairingKeypair, welcome: PairWelcomeMsg): Buffer {
  if (!welcome?.nodePublicKeyB64 || !welcome?.wrapped) throw new Error("Malformed pair.welcome");
  const wrapKey = deriveWrapKey(keypair.privateKeyB64, welcome.nodePublicKeyB64, "pair");
  return unwrapRoomKey(wrapKey, welcome.wrapped);
}

/**
 * A tiny stateful helper wrapping the room key for a session: seal outbound
 * client messages and open inbound node frames. Transport-agnostic — feed it the
 * relay's decrypted frame payloads and send its sealed output over the relay.
 */
export class RoomCipher {
  constructor(private readonly roomKey: Buffer) {}
  seal(message: unknown): string {
    return sealFrame(this.roomKey, message);
  }
  open(payload: string): Frame {
    return openFrame(this.roomKey, payload);
  }
  key(): Buffer {
    return this.roomKey;
  }
}
