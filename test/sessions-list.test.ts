import assert from "node:assert";
// Pure list-sizing logic for `bivy sessions` / `bivy ls` (bin/sessions-list.mjs).
import { nativeResumeRef, resolveSessionsLimit, truncateSavedSessions } from "../bin/sessions-list.mjs";

function run() {
  // --- resolveSessionsLimit -------------------------------------------------
  // No flag (empty string / undefined / null) → unlimited, so every saved
  // session is listed and resumable, not just the most recent ones (#71).
  assert.equal(resolveSessionsLimit(""), Infinity, "no --limit → unlimited");
  assert.equal(resolveSessionsLimit(undefined), Infinity, "undefined → unlimited");
  assert.equal(resolveSessionsLimit(null), Infinity, "null → unlimited");

  // A positive number caps the list.
  assert.equal(resolveSessionsLimit("15"), 15, "'15' → 15");
  assert.equal(resolveSessionsLimit("1"), 1, "'1' → 1");
  assert.equal(resolveSessionsLimit(40), 40, "numeric 40 → 40");
  assert.equal(resolveSessionsLimit("7.9"), 7, "fractional is floored");

  // Non-positive / non-numeric input is treated as "no cap", never 0 (which
  // would hide every saved session).
  assert.equal(resolveSessionsLimit("0"), Infinity, "'0' → unlimited, not empty");
  assert.equal(resolveSessionsLimit("-5"), Infinity, "negative → unlimited");
  assert.equal(resolveSessionsLimit("abc"), Infinity, "garbage → unlimited");

  // --- truncateSavedSessions ------------------------------------------------
  const sessions = Array.from({ length: 30 }, (_, i) => ({ id: `s${i}` }));

  // Default (unlimited) returns every session — the core of the fix: a user with
  // more than the old 15-cap now sees all of them.
  assert.equal(truncateSavedSessions(sessions, resolveSessionsLimit("")).length, 30, "unlimited keeps all 30");

  // An explicit cap trims to that many, newest-first order preserved.
  const capped = truncateSavedSessions(sessions, resolveSessionsLimit("5"));
  assert.equal(capped.length, 5, "cap 5 → 5 items");
  assert.deepEqual(capped.map((s) => s.id), ["s0", "s1", "s2", "s3", "s4"], "keeps the first (most recent) 5");

  // A cap larger than the list just returns the whole list.
  assert.equal(truncateSavedSessions(sessions, resolveSessionsLimit("100")).length, 30, "over-cap keeps all");

  // Empty input is safe.
  assert.deepEqual(truncateSavedSessions([], resolveSessionsLimit("")), [], "empty list stays empty");

  // Native resume must prefer the provider ref over Bivy's canonical id. A
  // forked/imported Codex chat commonly has both, and Codex only knows the ref.
  assert.equal(nativeResumeRef({ id: "bivy-id", ref: "codex-rollout-id" }), "codex-rollout-id");
  assert.equal(nativeResumeRef({ id: "same-id" }), "same-id", "legacy rows fall back to their canonical id");

  console.log("sessions-list: all tests passed");
}

run();
