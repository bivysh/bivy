// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import type { NodeRecord, SessionIndexEntry } from "../src/store.js";
import { countActiveAccountSessions } from "../src/session-count.js";

/**
 * The active-session count drives the plan's session cap. It must count only
 * sessions genuinely open on a reachable node — not "saved" (closed) sessions
 * or sessions stranded on an offline node, both of which still appear in the
 * cross-node list. Counting those made the cap trip with fewer than N sessions
 * actually open ("session enforcement seems off").
 */

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

function node(id: string, online: boolean): NodeRecord {
  return { id, accountId: "acct", name: id, enrollmentTokenHash: "h", online, lastSeenAt: null, createdAt: "2026-01-01T00:00:00.000Z" };
}
function session(sessionId: string, nodeId: string, status: string): SessionIndexEntry {
  return { sessionId, nodeId, status, updatedAt: "2026-01-01T00:00:00.000Z" };
}

await test("counts live sessions on online nodes across statuses", () => {
  const nodes = [node("n1", true)];
  const sessions = [
    session("s1", "n1", "idle"),
    session("s2", "n1", "working"),
    session("s3", "n1", "needs_action"),
  ];
  assert.equal(countActiveAccountSessions(sessions, nodes), 3);
});

await test("excludes saved (closed) sessions", () => {
  const nodes = [node("n1", true)];
  const sessions = [
    session("s1", "n1", "idle"),
    session("s2", "n1", "saved"),
    session("s3", "n1", "saved"),
  ];
  assert.equal(countActiveAccountSessions(sessions, nodes), 1);
});

await test("excludes sessions stranded on an offline node", () => {
  const nodes = [node("n1", true), node("n2", false)];
  const sessions = [
    session("s1", "n1", "idle"),
    session("s2", "n2", "idle"), // node offline — not actually running
    session("s3", "n2", "working"),
  ];
  assert.equal(countActiveAccountSessions(sessions, nodes), 1);
});

await test("regression: a mix of saved + offline stays well under the cap", () => {
  // Mirrors the reported screenshot: one live remote session, several saved
  // sessions, and a couple of untitled sessions on an offline node. Only the
  // single live one counts, so a 10-session cap must not trip.
  const nodes = [node("remote", true), node("mac", false)];
  const sessions = [
    session("live", "remote", "working"),
    session("saved-1", "remote", "saved"),
    session("saved-2", "remote", "saved"),
    session("saved-3", "remote", "saved"),
    session("saved-4", "remote", "saved"),
    session("offline-1", "mac", "idle"),
    session("offline-2", "mac", "idle"),
  ];
  assert.equal(countActiveAccountSessions(sessions, nodes), 1);
});

await test("empty inputs count as zero", () => {
  assert.equal(countActiveAccountSessions([], []), 0);
  assert.equal(countActiveAccountSessions([session("s1", "n1", "idle")], []), 0);
});

console.log(`\nsession-count: ${passed} tests passed`);
