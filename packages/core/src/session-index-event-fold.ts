// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

/** Pure event data understood by the session-index fold. */
export interface SessionIndexEventData {
  type?: unknown;
  sessionId?: unknown;
}

export interface PausedSessionsValue {
  readonly pausedSessionIds: readonly string[];
}

export type SessionIndexFoldResult<T extends PausedSessionsValue> =
  | { handled: false; value: T }
  | { handled: true; value: T };

/** Fold pause/resume facts without store identity, subscriptions, clocks, or effects. */
export function foldSessionIndexEvent<T extends PausedSessionsValue>(
  value: T,
  event: SessionIndexEventData,
): SessionIndexFoldResult<T> {
  const sessionId = String(event.sessionId || "");
  if (event.type === "session.paused") {
    if (!sessionId || value.pausedSessionIds.includes(sessionId)) return { handled: true, value };
    return { handled: true, value: { ...value, pausedSessionIds: [...value.pausedSessionIds, sessionId] } };
  }
  if (event.type === "session.resumed") {
    if (!sessionId || !value.pausedSessionIds.includes(sessionId)) return { handled: true, value };
    return { handled: true, value: { ...value, pausedSessionIds: value.pausedSessionIds.filter((id) => id !== sessionId) } };
  }
  return { handled: false, value };
}
