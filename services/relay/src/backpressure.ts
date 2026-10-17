// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

/**
 * Slow-consumer backpressure for the relay.
 *
 * The relay forwards E2E-opaque, non-superseding frames between a node and its
 * clients. If a consumer stops reading (a stuck phone, or a dead-but-not-closed
 * TCP socket behind mobile NAT), `ws` queues everything we forward in the
 * relay's OWN memory with no bound. We cannot silently drop a frame (that would
 * corrupt the session's encrypted stream), so instead we EVICT a backed-up
 * socket: terminating it frees the queued memory immediately and the peer
 * reconnects and re-syncs from the node. A graceful close would not: its close
 * frame queues behind the bytes the peer isn't reading, holding them until the
 * close handshake times out.
 *
 * Two limits apply. The per-socket mark stops one stuck consumer from growing
 * without bound. The relay-wide budget stops many of them at once (a mobile
 * network blip stalls hundreds of phones together) from adding up to an OOM:
 * past the budget, any socket holding more than one max-size frame is shed. A
 * healthy socket hands frames to the kernel as they arrive and is never touched.
 */

// The subset of `ws`'s WebSocket we depend on — kept structural so this module
// stays dependency-free and unit-testable without a real socket.
export interface ForwardTarget {
  readyState: number;
  bufferedAmount: number;
  send(data: Buffer, options: { binary: boolean }, cb: (error?: Error) => void): void;
  terminate(): void;
}

/** ws.OPEN — the WebSocket-standard readyState for an open connection. */
export const WS_OPEN = 1;

export type ForwardResult = "sent" | "skipped" | "evicted";

/**
 * Bytes handed to `ws` but not yet written to the kernel, across every socket.
 * Each send adds its size and its write callback (which `ws` also calls when the
 * socket dies first) takes it back off.
 */
export class BufferBudget {
  queued = 0;
  constructor(
    /** A socket holding more than this is evicted. */
    readonly perSocketBytes: number,
    /** Past this relay-wide total, a socket holding more than `pressureBytes` is evicted. */
    readonly totalBytes: number,
    /** What counts as backed up under pressure; one max-size frame. */
    readonly pressureBytes: number,
  ) {}
}

/**
 * Forward `data` (a text frame, sent as-is) to `target`, evicting it instead if
 * it is backed up. Returns what happened so the caller can update metrics.
 */
export function forwardOrEvict(target: ForwardTarget, data: Buffer, budget: BufferBudget): ForwardResult {
  if (target.readyState !== WS_OPEN) return "skipped";
  const backedUp = target.bufferedAmount > budget.perSocketBytes
    || (budget.queued > budget.totalBytes && target.bufferedAmount > budget.pressureBytes);
  if (backedUp) {
    target.terminate();
    return "evicted";
  }
  const bytes = data.length;
  budget.queued += bytes;
  target.send(data, { binary: false }, () => {
    budget.queued -= bytes;
  });
  return "sent";
}
