// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
//
// Encryption at rest for hosted-provisioning credentials (see
// docs/hosted-provisioning-trust-model.md). Secrets are sealed with
// AES-256-GCM under a per-account subkey derived from a single master key via
// HKDF-SHA256, so ciphertext is bound to its account (moving an envelope to
// another account fails auth) and no plaintext credential is ever written to
// the database.
//
// The master key comes from HOSTED_CREDENTIAL_KEY (base64, 32 bytes). It is the
// interim stand-in for a KMS/HSM: swap `masterKey()` for a KMS decrypt call to
// upgrade without touching callers. Writing a secret while the key is unset
// FAILS CLOSED (throws), so a misconfigured deployment can never persist a
// plaintext credential.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

const INFO = Buffer.from("bivy-hosted-provisioning-v1");

function masterKey(): Buffer | null {
  const b64 = process.env.HOSTED_CREDENTIAL_KEY;
  if (!b64) return null;
  let buf: Buffer;
  try {
    buf = Buffer.from(b64, "base64");
  } catch {
    return null;
  }
  return buf.length === 32 ? buf : null;
}

/** Whether a valid master key is configured (hosted secret writes require it). */
export function hostedEncryptionAvailable(): boolean {
  return masterKey() != null;
}

function accountKey(accountId: string): Buffer {
  const mk = masterKey();
  if (!mk) throw new Error("HOSTED_CREDENTIAL_KEY is not configured — refusing to handle hosted credentials");
  // Per-account subkey: HKDF(masterKey, salt=accountId, info=INFO).
  return Buffer.from(hkdfSync("sha256", mk, Buffer.from(accountId, "utf8"), INFO, 32));
}

export interface SecretEnvelope {
  v: 1;
  iv: string;
  ct: string;
  tag: string;
}

export function isSecretEnvelope(v: unknown): v is SecretEnvelope {
  return !!v && typeof v === "object" && (v as { v?: unknown }).v === 1
    && typeof (v as SecretEnvelope).iv === "string"
    && typeof (v as SecretEnvelope).ct === "string"
    && typeof (v as SecretEnvelope).tag === "string";
}

/** Seal a plaintext secret for `accountId`. Throws if no master key is set. */
export function encryptSecret(accountId: string, plaintext: string): SecretEnvelope {
  const key = accountKey(accountId);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { v: 1, iv: iv.toString("base64"), ct: ct.toString("base64"), tag: tag.toString("base64") };
}

/** Open a sealed secret for `accountId`. Throws on wrong account / tampering. */
export function decryptSecret(accountId: string, env: SecretEnvelope): string {
  const key = accountKey(accountId);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(env.iv, "base64"));
  decipher.setAuthTag(Buffer.from(env.tag, "base64"));
  const pt = Buffer.concat([decipher.update(Buffer.from(env.ct, "base64")), decipher.final()]);
  return pt.toString("utf8");
}

/** Constant-time compare for bearer-style secrets (e.g. enrollment tokens). */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
