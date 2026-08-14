// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// In-memory duplex pairing a daemon-side RpcTransport to a service-side
// ServiceConnection, so the RemoteRuntime ↔ AgentService round-trip can be
// tested in-process without a socket. Messages are delivered on a microtask to
// mimic real async ordering (never synchronously re-entrant).

import type { RpcTransport } from "../../src/runtime/remote.js";
import type { ServiceConnection } from "../../src/runtime/agent-service.js";
import type { ClientMessage, ServerMessage } from "../../src/runtime/rpc-protocol.js";

export interface MemoryPair {
  client: RpcTransport;
  server: ServiceConnection;
  /** True once either side has closed. */
  closed: () => boolean;
}

export function memoryPair(): MemoryPair {
  let clientOnMsg: ((m: ServerMessage) => void) | undefined;
  let clientOnClose: ((err?: Error) => void) | undefined;
  let serverOnMsg: ((m: ClientMessage) => void) | undefined;
  let serverOnClose: (() => void) | undefined;
  let isClosed = false;

  const doClose = () => {
    if (isClosed) return;
    isClosed = true;
    queueMicrotask(() => {
      serverOnClose?.();
      clientOnClose?.(undefined);
    });
  };

  const client: RpcTransport = {
    send: (m) => {
      if (!isClosed) queueMicrotask(() => serverOnMsg?.(m));
    },
    onMessage: (h) => (clientOnMsg = h),
    onClose: (h) => (clientOnClose = h),
    close: doClose,
  };
  const server: ServiceConnection = {
    send: (m) => {
      if (!isClosed) queueMicrotask(() => clientOnMsg?.(m));
    },
    onMessage: (h) => (serverOnMsg = h),
    onClose: (h) => (serverOnClose = h),
    close: doClose,
  };
  return { client, server, closed: () => isClosed };
}
