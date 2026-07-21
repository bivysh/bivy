// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes, randomUUID, createHash, timingSafeEqual } from "node:crypto";

/**
 * Node identity + device token store.
 *
 * Persists a stable per-install `nodeId` and a set of revocable device access
 * tokens in `.bivy/node.json`. Raw tokens are returned to the caller
 * exactly once (at creation); only SHA-256 hashes are stored on disk.
 */

export interface DeviceRecord {
  id: string;
  name: string;
  tokenHash: string;
  createdAt: string;
  lastSeenAt: string | null;
}

interface NodeConfig {
  nodeId: string;
  name: string;
  createdAt: string;
  devices: DeviceRecord[];
}

function defaultNodeName() {
  return os.hostname();
}

function migrateNodeName(name: string) {
  return name.replace(/\s+local node$/i, "");
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export class NodeIdentity {
  private config: NodeConfig;

  private constructor(
    private readonly configPath: string,
    config: NodeConfig,
  ) {
    this.config = config;
  }

  static load(appDir: string): NodeIdentity {
    const configPath = path.join(appDir, "node.json");
    fs.mkdirSync(appDir, { recursive: true });

    let config: NodeConfig;
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as Partial<NodeConfig>;
      config = {
        nodeId: typeof raw.nodeId === "string" && raw.nodeId ? raw.nodeId : `node_${randomUUID()}`,
        name:
          typeof raw.name === "string" && raw.name.trim()
            ? migrateNodeName(raw.name.trim())
            : defaultNodeName(),
        createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
        devices: Array.isArray(raw.devices) ? (raw.devices as DeviceRecord[]) : [],
      };
    } catch {
      config = {
        nodeId: `node_${randomUUID()}`,
        name: defaultNodeName(),
        createdAt: new Date().toISOString(),
        devices: [],
      };
    }

    const identity = new NodeIdentity(configPath, config);
    identity.persist();
    return identity;
  }

  private persist() {
    fs.writeFileSync(this.configPath, `${JSON.stringify(this.config, null, 2)}\n`, { mode: 0o600 });
    try {
      fs.chmodSync(this.configPath, 0o600);
    } catch {
      // Best effort on platforms without chmod.
    }
  }

  get nodeId() {
    return this.config.nodeId;
  }

  get name() {
    return this.config.name;
  }

  setName(name: string) {
    const clean = name.trim().replace(/\s+/g, " ").slice(0, 80);
    if (!clean) throw new Error("Node name cannot be empty");
    this.config.name = clean;
    this.persist();
    return clean;
  }

  listDevices() {
    return this.config.devices.map(({ tokenHash: _hash, ...rest }) => rest);
  }

  /**
   * Create a new device token. Returns the raw token, which is shown to the
   * user exactly once and never recoverable afterwards.
   */
  createDevice(name: string): { device: Omit<DeviceRecord, "tokenHash">; token: string } {
    const clean = name.trim().slice(0, 80) || "Unnamed device";
    const token = `mesh_${randomBytes(32).toString("base64url")}`;
    const record: DeviceRecord = {
      id: `dev_${randomUUID()}`,
      name: clean,
      tokenHash: hashToken(token),
      createdAt: new Date().toISOString(),
      lastSeenAt: null,
    };
    this.config.devices.push(record);
    this.persist();
    const { tokenHash: _hash, ...device } = record;
    return { device, token };
  }

  revokeDevice(id: string) {
    const before = this.config.devices.length;
    this.config.devices = this.config.devices.filter((device) => device.id !== id);
    const removed = this.config.devices.length < before;
    if (removed) this.persist();
    return removed;
  }

  /**
   * Verify a raw token against stored hashes using a constant-time compare.
   * Updates lastSeenAt on a match. Returns the matched device id, or null.
   */
  verifyToken(token: string | undefined | null): string | null {
    if (!token) return null;
    const candidateBuf = Buffer.from(hashToken(token), "hex");
    for (const device of this.config.devices) {
      const storedBuf = Buffer.from(device.tokenHash, "hex");
      if (storedBuf.length === candidateBuf.length && timingSafeEqual(storedBuf, candidateBuf)) {
        device.lastSeenAt = new Date().toISOString();
        this.persist();
        return device.id;
      }
    }
    return null;
  }
}
