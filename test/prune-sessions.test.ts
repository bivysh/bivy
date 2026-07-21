import assert from "node:assert";
// Pure selection logic for `bivy prune --sessions` (bin/prune-sessions.mjs).
import { isEmptySession, selectStaleSessions, sessionActivityMs } from "../bin/prune-sessions.mjs";

// Minutes-ago helper: returns an ISO timestamp `m` minutes before `now`.
const NOW = Date.parse("2026-07-12T12:00:00.000Z");
const ago = (m: number) => new Date(NOW - m * 60_000).toISOString();

function run() {
  // --- isEmptySession -------------------------------------------------------
  assert.equal(isEmptySession({ name: "", firstMessage: "", messageCount: 0 }), true, "blank is empty");
  assert.equal(isEmptySession({ name: "Untitled session" }), true, "'Untitled session' is empty");
  assert.equal(isEmptySession({ name: "Real work" }), false, "named session is non-empty");
  assert.equal(isEmptySession({ firstMessage: "hi" }), false, "first message makes it non-empty");
  assert.equal(isEmptySession({ messageCount: 3 }), false, "messages make it non-empty");

  // --- sessionActivityMs falls back through the fields ----------------------
  assert.equal(sessionActivityMs({ lastActivityAt: ago(1), updatedAt: ago(9) }), NOW - 60_000, "prefers lastActivityAt");
  assert.equal(sessionActivityMs({ createdAt: ago(5) }), NOW - 300_000, "falls back to createdAt");
  assert.equal(sessionActivityMs({}), 0, "no timestamp → 0");

  // --- selectStaleSessions --------------------------------------------------
  // A mix of agents, ages, one live session, and empties.
  const sessions = [
    { id: "live", name: "in progress", status: "working", updatedAt: ago(0) }, // never removed
    { id: "n1", name: "newest", updatedAt: ago(1) },
    { id: "n2", name: "codex thing", runtimeId: "codex", updatedAt: ago(2) },
    { id: "n3", name: "third", updatedAt: ago(3) },
    { id: "e1", name: "", firstMessage: "", messageCount: 0, updatedAt: ago(4) }, // empty
    { id: "n4", name: "fourth", updatedAt: ago(120) }, // 2h old
    { id: "e2", name: "Untitled session", updatedAt: ago(5) }, // empty
  ];

  // keep 3 non-empty, no age bound. Live is protected; n1..n3 survive; the rest go.
  const keep3 = new Set(selectStaleSessions(sessions, 3, null, NOW).map((s) => s.id));
  assert.deepEqual([...keep3].sort(), ["e1", "e2", "n4"], "keep 3 non-empty removes empties + older non-empty");
  assert.equal(keep3.has("live"), false, "live session is never selected");

  // keep 10 (more than exist): only empties are removed, no real session touched.
  const keep10 = selectStaleSessions(sessions, 10, null, NOW).map((s) => s.id).sort();
  assert.deepEqual(keep10, ["e1", "e2"], "generous keep still drops empty/untitled noise");

  // age-only: keep=null → everything (empty or not) older than 60m is eligible,
  // live still excluded. Only n4 (2h) qualifies.
  const ageOnly = selectStaleSessions(sessions, null, 60 * 60_000, NOW).map((s) => s.id);
  assert.deepEqual(ageOnly, ["n4"], "age-only removes anything older than the age, live excluded");

  // keep + age intersection: removed only when BOTH beyond keep AND older than age.
  // keep 3 leaves n1..n3; of the rest (e1, e2, n4) only n4 is older than 60m.
  const both = selectStaleSessions(sessions, 3, 60 * 60_000, NOW).map((s) => s.id);
  assert.deepEqual(both, ["n4"], "keep+age is the safe intersection");

  // Newest-first ordering of the returned set.
  const ordered = selectStaleSessions(sessions, 0, null, NOW).map((s) => s.id);
  assert.deepEqual(ordered, ["n1", "n2", "n3", "e1", "e2", "n4"], "keep 0 removes all non-live, newest first");

  console.log("prune-sessions: all tests passed");
}

run();
