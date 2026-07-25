// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  generatePairingKeypair,
  generateRoomKey,
  generatePairSecret,
  deriveWrapKey,
  verifyPairingProof,
  wrapRoomKey,
  type PairingKeypair,
} from "./pairing-crypto.js";
import { seal, open } from "./e2e.js";

/**
 * Node-side registry of linked remote devices and the pairing/room-key state,
 * persisted to `.bivy/pairing.json` (0600).
 *
 * Holds:
 *  - the node's long-term X25519 identity keypair (its public key goes in the QR),
 *  - the current symmetric room key (bulk frame encryption, shared by all devices),
 *  - the set of linked devices (id, public key, label) so we can re-wrap the room
 *    key to the survivors when one device is revoked,
 *  - short-lived, single-use pairing secrets issued for each linking QR (in memory
 *    only — pairing is interactive).
 *
 * See docs/security-model.md and src/pairing-crypto.ts for the protocol.
 */

export interface LinkedDevice {
  id: string;
  publicKeyB64: string;
  label: string;
  createdAt: string;
  lastSeenAt: string | null;
}

interface PairingFile {
  nodeKeypair: PairingKeypair;
  roomKeyB64: string;
  devices: LinkedDevice[];
}

export interface PairWelcome {
  deviceId: string;
  nodePublicKeyB64: string;
  wrapped: string; // room key wrapped under the ECDH "pair" key
}

export interface RotateDelivery {
  deviceId: string;
  wrapped: string; // new room key wrapped under the device's ECDH "rotate" key
}

const DEFAULT_PAIR_TTL_MS = 5 * 60_000;

export class PairingStore {
  private readonly filePath: string;
  private data: PairingFile;
  private readonly pendingSecrets = new Map<string, number>(); // secret -> expiry (ms)

  private constructor(filePath: string, data: PairingFile) {
    this.filePath = filePath;
    this.data = data;
  }

  /**
   * Load (or create) the pairing state. A fresh state gets a randomly generated
   * room key; devices receive it (and every later rotation) over the X25519
   * pairing handshake, so there is no static seed to carry forward.
   */
  static load(appDir: string): PairingStore {
    const filePath = path.join(appDir, "pairing.json");

    let raw: string | undefined;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch (error) {
      // Only a missing file means "never paired yet". Any other read failure
      // (permission denied, I/O error, etc.) must not mint a fresh identity.
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }

    if (raw !== undefined) {
      let parsed: Partial<PairingFile>;
      try {
        parsed = JSON.parse(raw) as Partial<PairingFile>;
      } catch {
        // The file exists but is corrupt/truncated. Minting a fresh keypair and
        // room key here would silently invalidate every paired device, so fail
        // loudly instead and let the operator decide how to recover.
        throw new Error(
          `Pairing state file at ${filePath} is corrupt and could not be parsed. Refusing to generate a ` +
            `new keypair/room key (this would invalidate every paired device). Restore it from a backup, ` +
            `or remove the file manually if you intend to start fresh.`,
        );
      }
      if (!parsed.nodeKeypair?.publicKeyB64 || !parsed.roomKeyB64) {
        throw new Error(
          `Pairing state file at ${filePath} is missing required fields (nodeKeypair/roomKeyB64). Refusing ` +
            `to generate a new keypair/room key (this would invalidate every paired device). Restore it ` +
            `from a backup, or remove the file manually if you intend to start fresh.`,
        );
      }
      return new PairingStore(filePath, {
        nodeKeypair: parsed.nodeKeypair,
        roomKeyB64: parsed.roomKeyB64,
        devices: Array.isArray(parsed.devices) ? parsed.devices : [],
      });
    }

    const data: PairingFile = {
      nodeKeypair: generatePairingKeypair(),
      roomKeyB64: generateRoomKey().toString("base64"),
      devices: [],
    };
    const store = new PairingStore(filePath, data);
    store.persist();
    return store;
  }

  private persist() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    // Atomic write: write to a tmp file in the same directory, then rename over
    // the target, so readers never observe a partially-written/truncated file.
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    try {
      fs.chmodSync(tmp, 0o600);
    } catch {
      // best effort on platforms without chmod
    }
    fs.renameSync(tmp, this.filePath);
    try {
      fs.chmodSync(this.filePath, 0o600);
    } catch {
      // best effort on platforms without chmod
    }
  }

  nodePublicKeyB64(): string {
    return this.data.nodeKeypair.publicKeyB64;
  }

  wrapForNodePublicKey(
    nodePublicKeyB64: string,
    plaintextB64: string,
    purpose: "model-auth-vault" | "github-app-vault" = "model-auth-vault",
  ): string {
    const wrapKey = deriveWrapKey(this.data.nodeKeypair.privateKeyB64, nodePublicKeyB64, purpose);
    return seal(wrapKey, plaintextB64);
  }

  unwrapFromNodePublicKey(
    nodePublicKeyB64: string,
    wrapped: string,
    purpose: "model-auth-vault" | "github-app-vault" = "model-auth-vault",
  ): string {
    const wrapKey = deriveWrapKey(this.data.nodeKeypair.privateKeyB64, nodePublicKeyB64, purpose);
    return open(wrapKey, wrapped);
  }

  roomKey(): Buffer {
    return Buffer.from(this.data.roomKeyB64, "base64");
  }

  /** Issue a single-use, expiring pairing secret to embed in a linking QR. */
  issuePairSecret(ttlMs = DEFAULT_PAIR_TTL_MS): string {
    this.sweepSecrets();
    const secret = generatePairSecret();
    this.pendingSecrets.set(secret, Date.now() + ttlMs);
    return secret;
  }

  private welcomeForTrustedDevice(input: { devicePublicKeyB64: string; label?: string }): PairWelcome | null {
    const { devicePublicKeyB64 } = input;
    if (!devicePublicKeyB64) return null;
    const existing = this.data.devices.find((d) => d.publicKeyB64 === devicePublicKeyB64);
    const device: LinkedDevice = existing ?? {
      id: `lnkdev_${randomUUID()}`,
      publicKeyB64: devicePublicKeyB64,
      label: (input.label ?? "Device").toString().slice(0, 60) || "Device",
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    };
    if (existing) existing.lastSeenAt = new Date().toISOString();
    else this.data.devices.push(device);
    this.persist();

    const wrapKey = deriveWrapKey(this.data.nodeKeypair.privateKeyB64, devicePublicKeyB64, "pair");
    return {
      deviceId: device.id,
      nodePublicKeyB64: this.data.nodeKeypair.publicKeyB64,
      wrapped: wrapRoomKey(wrapKey, this.roomKey()),
    };
  }

  /**
   * Handle a device's `pair.hello`. The device sends its public key and a proof
   * (HMAC over its public key keyed by the QR's pairing secret) — never the
   * secret itself. We match the proof against outstanding secrets; a relay that
   * never saw the QR cannot produce a valid proof. On success the device is
   * registered and the room key is wrapped for it. Returns null on failure.
   */
  handleHello(input: { devicePublicKeyB64: string; proofB64: string; label?: string }): PairWelcome | null {
    this.sweepSecrets();
    const { devicePublicKeyB64, proofB64 } = input;
    if (!devicePublicKeyB64 || !proofB64) return null;
    let matched: string | null = null;
    for (const secret of this.pendingSecrets.keys()) {
      if (verifyPairingProof(secret, devicePublicKeyB64, proofB64)) {
        matched = secret;
        break;
      }
    }
    if (!matched) return null;
    this.pendingSecrets.delete(matched); // single use
    return this.welcomeForTrustedDevice(input);
  }

  /** Trust a device that was authorized by the control plane account session. */
  trustDevice(input: { devicePublicKeyB64: string; label?: string }): PairWelcome | null {
    return this.welcomeForTrustedDevice(input);
  }

  listDevices(): LinkedDevice[] {
    return this.data.devices.map((d) => ({ ...d }));
  }

  touchDevice(deviceId: string) {
    const device = this.data.devices.find((d) => d.id === deviceId);
    if (device) {
      device.lastSeenAt = new Date().toISOString();
      this.persist();
    }
  }

  /**
   * Revoke a device: drop it, rotate the room key, and re-wrap the NEW room key
   * for every remaining device (using the "rotate" context). The revoked device
   * never receives the new key and its old key is now dead. Returns the per-device
   * wrapped deliveries for the caller to push over the relay, or null if the
   * device was not found.
   */
  revokeDevice(deviceId: string): RotateDelivery[] | null {
    const before = this.data.devices.length;
    this.data.devices = this.data.devices.filter((d) => d.id !== deviceId);
    if (this.data.devices.length === before) return null;
    return this.rotateRoomKey();
  }

  /** Rotate the room key and re-wrap it for all current devices. */
  rotateRoomKey(): RotateDelivery[] {
    this.data.roomKeyB64 = generateRoomKey().toString("base64");
    this.persist();
    const roomKey = this.roomKey();
    return this.data.devices.map((device) => ({
      deviceId: device.id,
      wrapped: wrapRoomKey(deriveWrapKey(this.data.nodeKeypair.privateKeyB64, device.publicKeyB64, "rotate"), roomKey),
    }));
  }

  private sweepSecrets() {
    const now = Date.now();
    for (const [secret, expiry] of this.pendingSecrets) {
      if (expiry < now) this.pendingSecrets.delete(secret);
    }
  }
}
