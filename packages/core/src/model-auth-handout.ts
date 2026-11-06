// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
//
// A signed-in device as a holder of the account's model-auth vault key.
//
// The account's machines wrap the vault key for each paired device. When a new
// machine asks for the key and none of the account's machines is online to
// answer, an open app on a paired device unwraps its copy and wraps it for the
// machine that asked. Same key exchange as machine to machine (X25519 + HKDF
// "bivy-model-auth-vault-v1" + AES-GCM); the control plane only relays
// ciphertext. The device passes the key through as the opaque string it
// received and never decrypts the vault itself.

import { open, seal } from "./crypto.js";
import { wrapKeyFor, type DeviceKeypair } from "./pairing.js";

export interface ModelAuthHandoutRemote {
  /** This device's copy of the vault key, and the machines waiting for one. */
  get(devicePublicKey: string): Promise<{
    wrappedKey: { wrappedKey: string; wrappedByPublicKey: string } | null;
    requests: Array<{ nodeId: string; publicKey: string }>;
  }>;
  /** Hand the key to one machine, wrapped to its public key. */
  put(input: { devicePublicKey: string; targetNodeId: string; wrappedKey: string }): Promise<void>;
}

/** Answer every machine waiting for the vault key. Returns how many were
 * answered; zero when this device holds no copy or nobody is waiting. */
export async function handOutModelAuthKey(remote: ModelAuthHandoutRemote, device: DeviceKeypair): Promise<number> {
  const { wrappedKey, requests } = await remote.get(device.pub);
  if (!wrappedKey || requests.length === 0) return 0;
  const vaultKey = await open(await wrapKeyFor(device.priv, wrappedKey.wrappedByPublicKey, "model-auth-vault"), wrappedKey.wrappedKey);
  let answered = 0;
  for (const request of requests) {
    const sealed = await seal(await wrapKeyFor(device.priv, request.publicKey, "model-auth-vault"), vaultKey);
    await remote.put({ devicePublicKey: device.pub, targetNodeId: request.nodeId, wrappedKey: sealed });
    answered++;
  }
  return answered;
}
