// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Pure list-sizing logic for `bivy sessions` / `bivy ls`, extracted so it can be
// unit-tested without executing the CLI (bin/bivy.mjs runs main() on import).
//
// Background (#71): sessions are never "active" vs "inactive" in storage — the
// server's /api/sessions already returns the full durable history, sorted most
// recent first (see listAllSessions in src/server.ts). `bivy sessions` used to
// hard-truncate that list to the newest 15 by default, which made older,
// perfectly resumable sessions invisible and unselectable-by-index. The default
// is now "no cap" (Infinity); --limit/--n remains an explicit opt-in to shorten
// the list.

// Resolve the --limit/--n value (the raw string from argValue, or "" / undefined
// when the flag wasn't passed) into the number of saved sessions to show.
// Anything that isn't a positive number means "no limit."
export function resolveSessionsLimit(rawArg) {
  const n = Number(rawArg);
  return n > 0 ? Math.floor(n) : Infinity;
}

// Apply the resolved limit to the (already most-recent-first) saved-sessions
// list. A plain wrapper over slice, kept alongside resolveSessionsLimit so the
// pairing is covered by one test file.
export function truncateSavedSessions(sessions, limit) {
  return sessions.slice(0, limit);
}

/**
 * Pick the provider-native token for a terminal resume. `id` is Bivy's
 * canonical conversation id; `ref` is the runtime's durable resume ref exposed
 * as `SessionSummary.path` (a Codex rollout id, a Claude session id, etc.).
 * They are often equal, but forks/imports deliberately give a conversation a
 * new Bivy id while retaining a different provider ref.
 */
export function nativeResumeRef(item) {
  return item?.ref || item?.id;
}
