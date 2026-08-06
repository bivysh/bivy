// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import {
  generateKeyPairSync,
  createPublicKey,
  createPrivateKey,
  diffieHellman,
  hkdfSync,
  createHmac,
  randomBytes,
  timingSafeEqual,
  type KeyObject,
} from "node:crypto";
import { seal, open } from "./e2e.js";
import { HKDF_INFO, ROOM_KEY_BYTES, WRAP_KEY_BYTES, PAIR_SECRET_BYTES } from "./wire-format.js";

/**
 * Pairing crypto for the X25519 device-linking handshake (replaces shipping the
 * room key inside the QR fragment).
 *
 * Design
 * ------
 * The node keeps a long-term X25519 identity keypair and a symmetric ROOM KEY
 * used for bulk frame encryption (so the relay still broadcasts one ciphertext
 * to all devices, exactly as before). Pairing establishes, per device, a stable
 * "wrap key" via ECDH(node_priv, device_pub); the node delivers the current room
 * key encrypted under that wrap key. The relay can route the wrapped key but
 * cannot derive the wrap key (it holds neither private key).
 *
 * Authenticating the device's public key
 * --------------------------------------
 * The node's public key reaches the phone OUT OF BAND via the QR (a trusted
 * screen), so the phone cannot be fooled about node identity. The phone's public
 * key reaches the node OVER the relay, so a malicious relay could try to
 * substitute its own. We bind the first exchange with a high-entropy
 * `pairSecret` carried only in the QR (never over the relay): the phone proves
 * knowledge of it with HMAC(pairSecret, device_pub). The relay never saw the QR,
 * so it cannot forge the proof — at worst it can cause pairing to fail, never to
 * leak the room key. After the first exchange the node stores the authentic
 * device public key and can re-wrap future room keys (on revoke/rotate) without
 * re-scanning.
 *
 * Wire encoding is base64url for all key material so it survives JSON/QR/URLs.
 */

const PAIR_INFO = Buffer.from(HKDF_INFO.pair);
const ROTATE_INFO = Buffer.from(HKDF_INFO.rotate);
const MODEL_AUTH_VAULT_INFO = Buffer.from(HKDF_INFO.modelAuthVault);
const GITHUB_APP_VAULT_INFO = Buffer.from(HKDF_INFO.githubAppVault);
const DEVICE_VAULT_INFO = Buffer.from(HKDF_INFO.deviceVault);
const EMPTY_SALT = Buffer.alloc(0);

export interface PairingKeypair {
  publicKeyB64: string; // raw 32-byte X25519 public key, base64url
  privateKeyB64: string; // PKCS8 DER private key, base64url
}

/** Generate a fresh X25519 keypair (node identity or device ephemeral). */
export function generatePairingKeypair(): PairingKeypair {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return {
    publicKeyB64: rawPublicKey(publicKey).toString("base64url"),
    privateKeyB64: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64url"),
  };
}

/** Raw 32-byte X25519 public key (the form WebCrypto exports/imports as "raw"). */
function rawPublicKey(key: KeyObject): Buffer {
  // JWK `x` is the base64url raw public key for OKP/X25519.
  const jwk = key.export({ format: "jwk" }) as { x?: string };
  if (!jwk.x) throw new Error("could not export X25519 public key");
  return Buffer.from(jwk.x, "base64url");
}

function publicKeyFromRaw(rawB64: string): KeyObject {
  return createPublicKey({
    key: { kty: "OKP", crv: "X25519", x: rawB64 } as Record<string, string>,
    format: "jwk",
  });
}

function privateKeyFromB64(privB64: string): KeyObject {
  return createPrivateKey({ key: Buffer.from(privB64, "base64url"), type: "pkcs8", format: "der" });
}

/**
 * Derive the per-device wrap key. Identical on both ends because ECDH is
 * symmetric: ECDH(node_priv, device_pub) === ECDH(device_priv, node_pub).
 */
export function deriveWrapKey(
  ourPrivateKeyB64: string,
  theirPublicKeyB64: string,
  purpose: "pair" | "rotate" | "model-auth-vault" | "github-app-vault" | "device-vault",
): Buffer {
  const shared = diffieHellman({
    privateKey: privateKeyFromB64(ourPrivateKeyB64),
    publicKey: publicKeyFromRaw(theirPublicKeyB64),
  });
  const info =
    purpose === "pair" ? PAIR_INFO
    : purpose === "rotate" ? ROTATE_INFO
    : purpose === "github-app-vault" ? GITHUB_APP_VAULT_INFO
    : purpose === "device-vault" ? DEVICE_VAULT_INFO
    : MODEL_AUTH_VAULT_INFO;
  return Buffer.from(hkdfSync("sha256", shared, EMPTY_SALT, info, WRAP_KEY_BYTES));
}

/** A fresh 32-byte symmetric room key. */
export function generateRoomKey(): Buffer {
  return randomBytes(ROOM_KEY_BYTES);
}

/** A high-entropy single-use pairing secret carried only in the QR. */
export function generatePairSecret(): string {
  return randomBytes(PAIR_SECRET_BYTES).toString("base64url");
}

/** HMAC-SHA256(pairSecret, device_pub) — the phone's proof it holds the QR secret. */
export function pairingProof(pairSecretB64: string, devicePublicKeyB64: string): string {
  return createHmac("sha256", Buffer.from(pairSecretB64, "base64url"))
    .update(Buffer.from(devicePublicKeyB64, "base64url"))
    .digest("base64url");
}

export function verifyPairingProof(pairSecretB64: string, devicePublicKeyB64: string, proofB64: string): boolean {
  const expected = pairingProof(pairSecretB64, devicePublicKeyB64);
  const a = Buffer.from(expected, "base64url");
  const b = Buffer.from(proofB64, "base64url");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Wrap (encrypt) the room key under a per-device wrap key for delivery. */
export function wrapRoomKey(wrapKey: Buffer, roomKey: Buffer): string {
  return seal(wrapKey, roomKey.toString("base64"));
}

export function unwrapRoomKey(wrapKey: Buffer, wrapped: string): Buffer {
  return Buffer.from(open(wrapKey, wrapped), "base64");
}
