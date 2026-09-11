// SPDX-License-Identifier: AGPL-3.0-only
import type { SessionStore } from "@bivy/core";

/** Bound the startup acknowledgement, not the installation (which may wait for
 * active turns). Older nodes can restart or drop the reply without answering. */
export function requestNodeUpdate(store: SessionStore, send: () => void | Promise<void>, timeoutMs = 15_000): void {
  const { currentNodeId, nodeUpdating } = store.getState().connection;
  if (nodeUpdating) return;
  store.setNodeUpdating(true);

  const isPending = () => {
    const connection = store.getState().connection;
    return connection.currentNodeId === currentNodeId && connection.nodeUpdating;
  };
  let settled = false;
  const cleanup = () => { settled = true; clearTimeout(timer); unsubscribe(); };
  const fail = (message: string) => {
    if (settled) return;
    cleanup();
    if (!isPending()) return;
    store.setNodeUpdating(false);
    store.setError(message);
  };
  const timer = setTimeout(() => fail(
    "The machine didn't confirm the update request. It may still be updating or waiting for active turns. Check `bivy update:log` on the machine before trying again.",
  ), timeoutMs);
  const unsubscribe = store.subscribe(() => {
    if (!isPending() || store.getState().connection.nodeUpdateAcknowledged) cleanup();
  });
  try {
    void Promise.resolve(send()).catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
