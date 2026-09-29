// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Pure session-selection logic for `bivy prune --sessions`, extracted so it can
// be unit-tested without executing the CLI (bin/bivy.mjs runs main() on import).
//
// Background: since terminal-started agents were adopted (shim → Bivy PTY →
// "continue as chat"), the sessions the app lists come from `.bivy/metadata.json`
// (the durable, deletion-aware index that drives the sidebar) across every agent —
// not just Pi's `.bivy/pi/sessions`. Prune selects from that index; these helpers
// decide which entries are stale. No I/O here on purpose.

import path from "node:path";

// Mirrors the server's isEmptyUntitledSummary: a session with no real title, no
// first message and no messages is the hidden "Untitled" noise the sidebar filters
// out. Keep-N protects only *real* sessions; empties are always eligible.
export function isUntitledSessionName(name) {
  const title = String(name ?? "").trim();
  return !title || /^untitled session$/i.test(title);
}

export function isEmptySession(s) {
  return isUntitledSessionName(s.name) && !String(s.firstMessage ?? "").trim() && Number(s.messageCount ?? 0) <= 0;
}

// Last-activity time in ms, most reliable field first.
export function sessionActivityMs(s) {
  for (const v of [s.lastActivityAt, s.updatedAt, s.modified, s.createdAt]) {
    const n = new Date(v).getTime();
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

// A Bivy-managed worktree lives at <repo>/.bivy/worktrees/<slug>. Only those are
// ever removed on a session's behalf — never an arbitrary path a record names.
export function isManagedWorktreePath(p) {
  const parts = path.resolve(String(p ?? "")).split(path.sep);
  return parts.length >= 3 && parts[parts.length - 3] === ".bivy" && parts[parts.length - 2] === "worktrees";
}

// Sessions and their worktrees are pruned as one unit, so neither outlives the
// other. Selection runs per kind (sessions and worktrees have different keep
// counts), then this links the two removal sets:
//   - a session goes when its worktree goes, or when its worktree is already
//     gone from disk (a session that can no longer open its checkout);
//   - a worktree goes when every session using it goes (and no live agent holds it).
// Live ("working") sessions are never added, and their worktree is never removed. `isLive(path)` / `exists(path)` are
// the caller's I/O; paths are compared resolved. Returns the widened sets.
export function linkSessionWorktrees({ sessions, staleSessions, staleWorktrees, isLive = () => false, exists = () => true }) {
  const removeSessions = new Map(staleSessions.map((s) => [s.id, s]));
  const removeWorktrees = new Set(staleWorktrees.map((p) => path.resolve(p)));
  const byWorktree = new Map();
  for (const s of sessions) {
    if (!s.worktree || !isManagedWorktreePath(s.worktree)) continue;
    const wt = path.resolve(s.worktree);
    byWorktree.set(wt, [...(byWorktree.get(wt) ?? []), s]);
  }
  for (const [wt, owners] of byWorktree) {
    if (owners.some((s) => s.status === "working")) removeWorktrees.delete(wt);
    else if (exists(wt) && owners.every((s) => removeSessions.has(s.id)) && !isLive(wt)) removeWorktrees.add(wt);
  }
  for (const [wt, owners] of byWorktree) {
    if (!removeWorktrees.has(wt) && exists(wt)) continue;
    for (const s of owners) if (s.status !== "working") removeSessions.set(s.id, s);
  }
  const sorted = [...removeSessions.values()].sort((a, b) => sessionActivityMs(b) - sessionActivityMs(a));
  return { sessions: sorted, worktrees: [...removeWorktrees] };
}

// Removal set for sessions. Live ("working") sessions are never touched. The
// newest `keep` NON-EMPTY sessions (across every agent) survive; empty/untitled
// sessions are always beyond the keep window. An item is removed only when it is
// BOTH beyond the keep window AND older than `ageMs` — the same safe intersection
// as the file-based selectStale, so keep-only and age-only both behave sensibly.
// `keep`/`ageMs` of null disable that half of the test.
export function selectStaleSessions(sessions, keep, ageMs, now) {
  const eligible = sessions.filter((s) => s.status !== "working");
  const nonEmptyDesc = eligible
    .filter((s) => !isEmptySession(s))
    .sort((a, b) => sessionActivityMs(b) - sessionActivityMs(a));
  const rank = new Map(nonEmptyDesc.map((s, i) => [s.id, i]));
  return eligible
    .filter((s) => {
      const beyondKeep = keep === null ? true : (isEmptySession(s) ? true : (rank.get(s.id) ?? Infinity) >= keep);
      const olderThan = ageMs === null ? true : now - sessionActivityMs(s) >= ageMs;
      return beyondKeep && olderThan;
    })
    .sort((a, b) => sessionActivityMs(b) - sessionActivityMs(a));
}
