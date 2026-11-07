// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
//
// The account's pool key: lets this fleet's machines start with the account's
// sign-ins while none of the account's own machines or devices is online, with
// no machine kept running for it.
//
// When an account turns this on, the fleet makes an X25519 keypair for it and
// hands Core only the public half. The account's machines wrap the credential
// vault key to that public key, and Core stores the wrap, which it can't open.
// Every machine the fleet starts for the account gets the private half as a
// boot file, so it can open the wrap itself. Whoever runs this fleet already
// runs the machines that use the decrypted credentials; this adds no one who
// could read them. Turning it off deletes the keypair and Core re-keys the vault.

import { generateKeyPairSync } from "node:crypto";
import type { MachineFile } from "./provider.js";
import type { FleetStore, PoolKey } from "./store.js";

/** Where a machine finds its pool key (read by the node at boot). */
export const POOL_KEY_PATH = "/etc/bivy/pool-key.json";

export function newPoolKey(): PoolKey {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  // Raw 32-byte public key, the form the node and the browser exchange.
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return { publicKey: raw.toString("base64url"), privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url") };
}

/** The account's public pool key, made on first ask. */
export async function poolPublicKey(store: FleetStore, accountId: string): Promise<string> {
  const existing = await store.getPoolKey(accountId);
  if (existing) return existing.publicKey;
  await store.putPoolKey(accountId, newPoolKey());
  return (await store.getPoolKey(accountId))!.publicKey;
}

/** The boot file carrying the account's pool key, when it has one. */
export async function poolKeyFiles(store: FleetStore, accountId: string): Promise<MachineFile[]> {
  const key = await store.getPoolKey(accountId);
  if (!key) return [];
  return [{ guest_path: POOL_KEY_PATH, raw_value: Buffer.from(JSON.stringify(key)).toString("base64") }];
}

/** A boot payload with the account's pool key added, if it has one. */
export async function withPoolKey<T extends { files: MachineFile[] }>(store: FleetStore, accountId: string, boot: T): Promise<T> {
  const files = await poolKeyFiles(store, accountId);
  return files.length ? { ...boot, files: [...boot.files, ...files] } : boot;
}
