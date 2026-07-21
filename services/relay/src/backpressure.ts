// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad

/**
 * Slow-consumer backpressure for the relay.
 *
 * The relay forwards E2E-opaque, non-superseding frames between a node and its
 * clients. If a consumer stops reading (a stuck phone, or a dead-but-not-closed
 * TCP socket behind mobile NAT), `ws` queues everything we forward in the
 * relay's OWN memory with no bound — one such socket can OOM a shard and take
 * down every room on it. We cannot silently drop a frame (that would corrupt the
 * session's encrypted stream), so instead we EVICT any socket whose outbound
 * buffer crosses a high-water mark: closing it frees the queued memory
 * immediately and the peer reconnects and re-syncs from the node. A healthy
 * socket never approaches the mark.
 */

// The subset of `ws`'s WebSocket we depend on — kept structural so this module
// stays dependency-free and unit-testable without a real socket.
export interface ForwardTarget {
  readyState: number;
  bufferedAmount: number;
  send(data: string): void;
  close(code: number, reason: string): void;
  terminate(): void;
}

/** ws.OPEN — the WebSocket-standard readyState for an open connection. */
export const WS_OPEN = 1;
/** RFC 6455 1013 "Try Again Later" — the apt close code for shedding a slow consumer. */
export const WS_SLOW_CONSUMER_CODE = 1013;

export type ForwardResult = "sent" | "skipped" | "evicted";

/**
 * Forward `text` to `target`, evicting it if its outbound buffer already exceeds
 * `maxBufferedBytes`. Returns what happened so the caller can update metrics.
 */
export function forwardOrEvict(target: ForwardTarget, text: string, maxBufferedBytes: number): ForwardResult {
  if (target.readyState !== WS_OPEN) return "skipped";
  if (target.bufferedAmount > maxBufferedBytes) {
    // Backed up: shed the socket instead of queuing more of the relay's memory.
    try {
      target.close(WS_SLOW_CONSUMER_CODE, "Slow consumer");
    } catch {
      target.terminate();
    }
    return "evicted";
  }
  target.send(text);
  return "sent";
}
