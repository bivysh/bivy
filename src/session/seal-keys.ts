// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
//
// Account seal keys: the keys that seal a session snapshot to the ACCOUNT
// rather than to the machine that wrote it, so any of the account's machines
// can restore the session.
//
// The keyring travels inside the end-to-end encrypted credential vault (see
// docs/credential-sync.md), so it reaches exactly the machines that can unwrap
// the vault, and the control plane only ever stores ciphertext. Keys are never
// removed: a snapshot written under an old key must stay readable. When the
// vault rotates because a machine was removed, a new key is added and becomes
// current, so the removed machine cannot read snapshots written after it left.
//
// A sealed snapshot names its key: `bivy-acct-v1:<kid>:<ciphertext>`. A
// snapshot without the prefix predates this and is sealed to the writing
// machine's room key.

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { open, seal } from "../e2e.js";
import { ACCOUNT_SEAL_PREFIX } from "../wire-format.js";

export interface SealKey {
  /** Base64 of 32 random bytes. */
  key: string;
  /** Milliseconds since the epoch; the newest key is current. */
  createdAt: number;
}

export type SealKeyring = Record<string, SealKey>;

export { ACCOUNT_SEAL_PREFIX };

const KID = /^[0-9a-f]{16}$/;

/** Keep only well-formed keys; anything else in a synced envelope is ignored. */
export function parseKeyring(value: unknown): SealKeyring {
  const ring: SealKeyring = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return ring;
  for (const [kid, entry] of Object.entries(value as Record<string, unknown>)) {
    const candidate = entry as Partial<SealKey> | null;
    if (!KID.test(kid) || !candidate || typeof candidate.key !== "string" || typeof candidate.createdAt !== "number") continue;
    if (Buffer.from(candidate.key, "base64").length !== 32) continue;
    ring[kid] = { key: candidate.key, createdAt: candidate.createdAt };
  }
  return ring;
}

/** Union of two keyrings. Both sides only ever add keys, so this never conflicts. */
export function mergeKeyrings(a: SealKeyring, b: SealKeyring): SealKeyring {
  return { ...b, ...a };
}

/** Whether `ring` holds every key in `other`. */
export function holdsAll(ring: SealKeyring, other: SealKeyring): boolean {
  return Object.keys(other).every((kid) => kid in ring);
}

export function mintSealKey(ring: SealKeyring, now = Date.now()): SealKeyring {
  return { ...ring, [randomBytes(8).toString("hex")]: { key: randomBytes(32).toString("base64"), createdAt: now } };
}

/** The key new snapshots are sealed with: the newest (ties broken by kid). */
export function currentSealKey(ring: SealKeyring): { kid: string; key: Buffer } | undefined {
  const [kid] = Object.keys(ring).sort((x, y) => ring[y].createdAt - ring[x].createdAt || (x < y ? -1 : 1));
  return kid ? { kid, key: Buffer.from(ring[kid].key, "base64") } : undefined;
}

export type Sealer = (plaintext: string) => string;
export type Opener = (payload: string) => string;

export function accountSealer(kid: string, key: Buffer): Sealer {
  return (plaintext) => `${ACCOUNT_SEAL_PREFIX}${kid}:${seal(key, plaintext)}`;
}

/** The legacy seal: the writing machine's own room key, no prefix. */
export function roomKeySealer(roomKey: Buffer): Sealer {
  return (plaintext) => seal(roomKey, plaintext);
}

/** The account key a sealed payload needs, or undefined for a room-key seal. */
export function sealedKid(payload: string): string | undefined {
  if (!payload.startsWith(ACCOUNT_SEAL_PREFIX)) return undefined;
  const kid = payload.slice(ACCOUNT_SEAL_PREFIX.length).split(":", 1)[0];
  return KID.test(kid) ? kid : undefined;
}

/** Open either kind of seal. Throws when the needed key isn't held. */
export function snapshotOpener(ring: SealKeyring, roomKey: Buffer): Opener {
  return (payload) => {
    if (!payload.startsWith(ACCOUNT_SEAL_PREFIX)) return open(roomKey, payload);
    const kid = sealedKid(payload);
    const entry = kid ? ring[kid] : undefined;
    if (!kid || !entry) throw new Error("This machine doesn't hold the account key this snapshot was sealed with yet");
    return open(Buffer.from(entry.key, "base64"), payload.slice(ACCOUNT_SEAL_PREFIX.length + kid.length + 1));
  };
}

/** The keyring this machine holds, in its app directory (mode 0600). */
export function keyringStore(appDir: string) {
  const file = path.join(appDir, "session-seal-keys.json");
  return {
    read(): SealKeyring {
      try {
        return parseKeyring(JSON.parse(fs.readFileSync(file, "utf8")));
      } catch {
        return {};
      }
    },
    write(ring: SealKeyring): void {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(ring, null, 2)}\n`, { mode: 0o600 });
      try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
    },
  };
}
