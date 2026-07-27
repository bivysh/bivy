// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
//
// Pure decision helpers for the queued-follow-ups feature (issue #154). Kept
// separate from AppController (packages/web) so the actual "when do we queue
// vs. send, and is steering even on the table" logic is unit-testable without
// standing up a controller (which needs a live Transport, localStorage, etc.)
// — see packages/core/test/followups.test.ts. SessionStore (store.ts) owns the
// data shape and CRUD (enqueue/edit/remove/reorder/...); this module is the
// small bit of policy layered on top of it.

import type { PendingFollowup } from "./store.js";

/**
 * A new prompt for a session must be held in the visible queue rather than
 * sent immediately when: the session is mid-turn (`working`), OR earlier
 * queued items are still waiting. The second clause matters even when the
 * session has gone idle — sending a fresh prompt straight through while older
 * ones are still queued would jump the queue and reorder ahead of them (the
 * "delivered in the displayed order" acceptance criterion).
 */
export function mustQueueFollowup(queueLength: number, working: boolean): boolean {
  return queueLength > 0 || working;
}

/**
 * Whether a runtime's advertised capabilities include explicit steer support
 * (`RuntimeCapabilities.streamingBehaviors` on the node — see
 * src/runtime/types.ts). Absent/malformed/empty all mean "no" — a runtime
 * must opt in before the client will ever attempt a mid-turn interrupt;
 * queueing is always the safe fallback (see mustQueueFollowup).
 */
export function supportsSteering(capabilities: { streamingBehaviors?: unknown } | null | undefined): boolean {
  const behaviors = capabilities?.streamingBehaviors;
  return Array.isArray(behaviors) && behaviors.includes("steer");
}

/** The next item to deliver from a session's queue: the first still-"queued"
 *  entry in display order. Skips anything already "sending"/"sent"/"failed" —
 *  the queue only ever has one item in flight at a time, but this stays
 *  correct even if that ever changes. Undefined when there's nothing to send. */
export function nextQueuedFollowup(items: readonly PendingFollowup[]): PendingFollowup | undefined {
  return items.find((f) => f.status === "queued");
}
