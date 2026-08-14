// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// SessionEngine — owns the live-session registry and the simple lifecycle, as
// the first behavioural slice of the session-engine decomposition.
//
// It CREATES and owns the `openSessions` Map and returns a reference: server.ts
// destructures it and still reads/writes records in place (the agreed Option 1 —
// shared mutable data, no god-object encapsulation yet). Node capabilities the
// lifecycle needs (the node-global `active` session, broadcast, advertise) are
// injected, so nothing here points back at server.ts. Turn lifecycle,
// close/abort, and createSession fold in over the next slices.
import type { SessionRecord } from "./record.js";

export interface SessionEngineDeps {
  /** The node's last-focused session — the fallback when a request names none. */
  getActive(): SessionRecord | undefined;
  /** Re-emit an event to every connected client (relay + direct sockets). */
  broadcast(event: unknown): void;
  /** Re-advertise node/session presence (pause/resume change reachability). */
  scheduleAdvertise(): void;
}

export function createSessionEngine({ getActive, broadcast, scheduleAdvertise }: SessionEngineDeps) {
  /** The live-session registry: sessionId -> record for every open session. */
  const openSessions = new Map<string, SessionRecord>();

  // Resolve which session a request targets. Clients may pass an explicit
  // `sessionId` (per-client focus / background sessions); when omitted we fall
  // back to the node's last-focused `active` session for backward compatibility.
  // If a client explicitly names a session, never fall back to the node-global
  // active session — parallel web/TUI clients can otherwise send a stale or
  // not-yet-known id and have their prompt/abort routed into another chat.
  const resolveSession = (sessionId?: unknown): SessionRecord | undefined => {
    const id = typeof sessionId === "string" && sessionId ? sessionId : undefined;
    return id ? openSessions.get(id) : getActive();
  };

  // Pause/resume: distinct from abort/kill. The agent process keeps running, but
  // the guardian forces every subsequent tool call to ask until resumed.
  const pauseSession = (record: SessionRecord): void => {
    record.paused = true;
    broadcast({ type: "session.paused", sessionId: record.id });
    scheduleAdvertise();
  };

  const resumeSession = (record: SessionRecord): void => {
    record.paused = false;
    broadcast({ type: "session.resumed", sessionId: record.id });
    scheduleAdvertise();
  };

  return { openSessions, resolveSession, pauseSession, resumeSession };
}
