// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

/** Storage/effect ports keep device resource semantics independent of Express,
 * the relay connector, and the concrete on-disk registries. */
export interface LinkedDevicePort<TDevice, TDelivery> {
  list(): TDevice[];
  revoke(id: string): TDelivery[] | null;
  onRevoked(id: string, deliveries: TDelivery[], devices: TDevice[]): void;
}

export interface AccessDevicePort<TDevice> {
  list(): TDevice[];
  create(name: string): { device: TDevice; token: string };
  revoke(id: string): boolean;
  onCreated(device: TDevice): void;
  onRevoked(id: string): void;
}

/** X25519-linked clients. Revocation rotates the shared room key, then exposes
 * one callback at the effect edge to persist metadata and notify survivors. */
export function createLinkedDeviceController<TDevice, TDelivery>(port: LinkedDevicePort<TDevice, TDelivery>) {
  return {
    list(): TDevice[] {
      return port.list();
    },
    revoke(id: string): { found: false } | { found: true; devices: TDevice[] } {
      const deliveries = port.revoke(id);
      if (!deliveries) return { found: false };
      const devices = port.list();
      port.onRevoked(id, deliveries, devices);
      return { found: true, devices };
    },
  };
}

/** Local bearer-token records. Raw tokens pass through exactly once from the
 * identity store; this controller never persists or logs them. */
export function createAccessDeviceController<TDevice>(port: AccessDevicePort<TDevice>) {
  return {
    list(): TDevice[] {
      return port.list();
    },
    create(name: string): { device: TDevice; token: string } {
      const created = port.create(name);
      port.onCreated(created.device);
      return created;
    },
    revoke(id: string): boolean {
      const removed = port.revoke(id);
      if (removed) port.onRevoked(id);
      return removed;
    },
  };
}
