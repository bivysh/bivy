// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Encryption at rest for hosted-provisioning credentials (see
// docs/hosted-provisioning-trust-model.md). Secrets are sealed with
// AES-256-GCM under a per-account subkey derived from a master key via
// HKDF-SHA256, so ciphertext is bound to its account (moving an envelope to
// another account fails auth) and no plaintext credential is ever written to
// the database.
//
// KEYRING + ROTATION. The control plane holds a *keyring* of one or more master
// keys, each with a short id (`kid`). Every envelope records the kid it was
// sealed with, so old ciphertext keeps decrypting while a new primary key is
// introduced. Rotation is then just "re-seal under the primary" (a no-op write
// through setHostedProvisioning). Keys come from the environment today; this is
// the single seam to replace with a KMS/HSM — swap `loadKeyring()` for a KMS
// call and nothing else changes.
//
// Config:
//   HOSTED_CREDENTIAL_KEYS="v2:<base64-32b>,v1:<base64-32b>"   (keyring)
//   HOSTED_CREDENTIAL_KEY_PRIMARY="v2"                          (active key)
//   HOSTED_CREDENTIAL_KEY="<base64-32b>"                        (legacy single, id "default")
//
// Writing a secret while no key is configured FAILS CLOSED (throws), so a
// misconfigured deployment can never persist a plaintext credential.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

const INFO = Buffer.from("bivy-hosted-provisioning-v1");
const LEGACY_KID = "default";

interface Keyring {
  primaryKid: string;
  keys: Map<string, Buffer>;
}

/** Hosted-key boundary for KMS/HSM implementations. Providers own encryption
 * and key derivation; the control plane stores only their opaque envelope.
 * Async methods support network KMS APIs without exposing key material. */
export interface HostedKeyProvider {
  available(): Promise<boolean>;
  primaryKeyId(): Promise<string | null>;
  encrypt(accountId: string, plaintext: string): Promise<SecretEnvelope>;
  decrypt(accountId: string, envelope: SecretEnvelope): Promise<string>;
}

let configuredProvider: HostedKeyProvider | null = null;
export function setHostedKeyProvider(provider: HostedKeyProvider | null): void { configuredProvider = provider; }
export function hostedKeyProvider(): HostedKeyProvider { return configuredProvider ?? environmentHostedKeyProvider; }

function decode32(b64: string): Buffer | null {
  let buf: Buffer;
  try {
    buf = Buffer.from(b64.trim(), "base64");
  } catch {
    return null;
  }
  return buf.length === 32 ? buf : null;
}

// The KMS seam: today keys come from the environment. Replace this function to
// source keys from a KMS/HSM (returning the same { primaryKid, keys } shape).
function loadKeyring(): Keyring | null {
  const keys = new Map<string, Buffer>();
  let primaryKid = "";

  const multi = process.env.HOSTED_CREDENTIAL_KEYS;
  if (multi) {
    for (const part of multi.split(",")) {
      const idx = part.indexOf(":");
      if (idx <= 0) continue;
      const kid = part.slice(0, idx).trim();
      const key = decode32(part.slice(idx + 1));
      if (kid && key) keys.set(kid, key);
    }
    primaryKid = (process.env.HOSTED_CREDENTIAL_KEY_PRIMARY || [...keys.keys()][0] || "").trim();
  }

  const single = process.env.HOSTED_CREDENTIAL_KEY;
  if (single) {
    const key = decode32(single);
    if (key) {
      keys.set(LEGACY_KID, key);
      if (!primaryKid) primaryKid = LEGACY_KID;
    }
  }

  if (!keys.size || !primaryKid || !keys.has(primaryKid)) return null;
  return { primaryKid, keys };
}

function requireKeyring(): Keyring {
  const kr = loadKeyring();
  if (!kr) throw new Error("No hosted credential key configured (HOSTED_CREDENTIAL_KEY[S]) — refusing to handle hosted credentials");
  return kr;
}

export const environmentHostedKeyProvider: HostedKeyProvider = {
  available: async () => hostedEncryptionAvailable(),
  primaryKeyId: async () => hostedPrimaryKid(),
  encrypt: async (accountId, plaintext) => encryptSecret(accountId, plaintext),
  decrypt: async (accountId, envelope) => decryptSecret(accountId, envelope),
};

/** Provider-driven async operations for hosted paths that may use KMS/HSM. */
export const encryptHostedSecret = (accountId: string, plaintext: string) => hostedKeyProvider().encrypt(accountId, plaintext);
export const decryptHostedSecret = (accountId: string, envelope: SecretEnvelope) => hostedKeyProvider().decrypt(accountId, envelope);

/** Whether at least one valid environment master key is configured. */
export function hostedEncryptionAvailable(): boolean {
  return loadKeyring() != null;
}

/** The active key id secrets are (re)sealed under — surfaced for status/rotation. */
export function hostedPrimaryKid(): string | null {
  return loadKeyring()?.primaryKid ?? null;
}

// Per-account subkey: HKDF(masterKey, salt=accountId, info=INFO).
function accountKey(master: Buffer, accountId: string): Buffer {
  return Buffer.from(hkdfSync("sha256", master, Buffer.from(accountId, "utf8"), INFO, 32));
}

export interface SecretEnvelope {
  v: 1;
  kid?: string; // key id; absent means the legacy single key ("default")
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

/** Seal a plaintext secret for `accountId` under the primary key. */
export function encryptSecret(accountId: string, plaintext: string): SecretEnvelope {
  const kr = requireKeyring();
  const key = accountKey(kr.keys.get(kr.primaryKid)!, accountId);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { v: 1, kid: kr.primaryKid, iv: iv.toString("base64"), ct: ct.toString("base64"), tag: tag.toString("base64") };
}

/** Open a sealed secret for `accountId` using the key the envelope was sealed with. */
export function decryptSecret(accountId: string, env: SecretEnvelope): string {
  const kr = requireKeyring();
  const kid = env.kid ?? LEGACY_KID;
  const master = kr.keys.get(kid);
  if (!master) throw new Error(`Hosted credential key '${kid}' is not in the keyring — cannot decrypt`);
  const key = accountKey(master, accountId);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(env.iv, "base64"));
  decipher.setAuthTag(Buffer.from(env.tag, "base64"));
  const pt = Buffer.concat([decipher.update(Buffer.from(env.ct, "base64")), decipher.final()]);
  return pt.toString("utf8");
}

/** Whether an envelope is already sealed under the current primary key. */
export function isSealedUnderPrimary(env: SecretEnvelope): boolean {
  const primary = hostedPrimaryKid();
  return primary != null && (env.kid ?? LEGACY_KID) === primary;
}

/** Constant-time compare for bearer-style secrets. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
