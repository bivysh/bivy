// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Source retirement for a session MOVE (1A). A "move" = fork to a destination,
// then retire the source. That retirement used to be a blind client `session.delete`
// after import: a client that crashed between import-success and delete left the
// source behind (a duplicate), and a bug could delete the source with no
// destination (a loss). True cross-node atomicity isn't possible — the transport
// is client-mediated (the client holds both nodes' room keys) — so this makes the
// retirement instead:
//   - CONFIRMATION-GATED: it refuses to retire without a `newSessionId` proving the
//     move actually produced a destination session (closes the loss window);
//   - IDEMPOTENT: retiring an already-gone source is a success, so the client can
//     safely RETRY until it sticks (closes the orphan/duplicate window).
//
// Pure orchestration over injected deps so it is unit-testable with fakes; the
// server wires the real deleteSessionFile / existence check / broadcast.

export interface ForkRetireInput {
  /** The source session to retire once its move is confirmed. */
  sourceSessionId: string;
  /** The destination session the move produced — REQUIRED (the confirmation). */
  newSessionId: string;
}

export type ForkRetireOutcome =
  | { ok: false; error: string }
  | { ok: true; retired: boolean; alreadyGone: boolean };

export interface ForkRetireDeps {
  /** True when the source session still exists on this node (live or in metadata). */
  sessionExists(sessionId: string): boolean;
  /** Remove the source session from this node. Only invoked when sessionExists()
   *  was true; the server owns any resulting session.deleted broadcast. */
  deleteSession(sessionId: string): Promise<void>;
}

export interface ForkRetire {
  retireSource(input: ForkRetireInput): Promise<ForkRetireOutcome>;
}

export function createForkRetire(deps: ForkRetireDeps): ForkRetire {
  async function retireSource(input: ForkRetireInput): Promise<ForkRetireOutcome> {
    const sourceSessionId = String(input.sourceSessionId ?? "").trim();
    const newSessionId = String(input.newSessionId ?? "").trim();
    if (!sourceSessionId) return { ok: false, error: "retire-source requires a sourceSessionId" };
    // The gate: never retire a source unless the move produced a destination.
    if (!newSessionId) {
      return { ok: false, error: "refusing to retire the source without a confirmed destination session" };
    }
    // Idempotent: an already-retired source is a success, so a client that
    // crashed mid-move can safely retry the retirement after it reconnects.
    if (!deps.sessionExists(sourceSessionId)) {
      return { ok: true, retired: false, alreadyGone: true };
    }
    await deps.deleteSession(sourceSessionId);
    return { ok: true, retired: true, alreadyGone: false };
  }
  return { retireSource };
}
