// SPDX-License-Identifier: AGPL-3.0-only
import type { LocalStore, Transport, TransportHandlers } from "@bivy/core";

/**
 * Get a machine's room key onto this device without changing the selected
 * machine. Connecting over the relay wakes a sleeping cloud computer; once the
 * machine is reachable, a device that lacks its key pairs with it through the
 * account (`pair.account`), the same as opening any machine for the first time.
 * Resolves when the key is stored; rejects on a pairing refusal or timeout.
 */
export function pairWithMachine(
  local: LocalStore,
  nodeId: string,
  connect: (store: LocalStore, handlers: TransportHandlers) => Transport,
  timeoutMs = 180_000,
): Promise<void> {
  if (local.keys()[nodeId]) return Promise.resolve();
  // RelayTransport reads `cur` from its store; scope only that to this machine.
  const scoped = new Proxy(local, {
    get: (target, property, receiver) => property === "cur" ? nodeId : Reflect.get(target, property, receiver),
    set: (target, property, value, receiver) => property === "cur" ? true : Reflect.set(target, property, value, receiver),
  });
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let lastError = "";
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      transport.close();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error(lastError || "The machine didn't come online in time.")), timeoutMs);
    const transport = connect(scoped, {
      onStatus: (status) => {
        if (status === "online" && local.keys()[nodeId]) finish();
        // The transport closes itself on a permanent pairing refusal.
        else if (status === "offline") finish(new Error(lastError || "The machine refused to pair with this device."));
      },
      onEvent: () => {},
      onError: (message) => { lastError = message; },
    });
    void transport.connect().catch((error: unknown) => finish(error instanceof Error ? error : new Error(String(error))));
  });
}
