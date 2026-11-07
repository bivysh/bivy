// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
// Session invites (src/session-invites.ts): what a guest may send and see.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionInvites, guestEvent, guestMayRun, guestRequestId } from "../src/session-invites.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "invites-"));
let now = Date.parse("2026-11-06T12:00:00Z");
const invites = new SessionInvites(dir, () => now);
const sessionOf = (c: Record<string, unknown>) => (typeof c.sessionId === "string" ? c.sessionId : undefined);

// A viewer reads its session; a prompter may also drive it; neither reaches
// another session or anything machine-wide.
const view = { id: "inv-1", sessionId: "s1", mode: "view" as const };
const prompt = { id: "inv-1", sessionId: "s1", mode: "prompt" as const };
assert.equal(guestMayRun(view, { kind: "session.open", sessionId: "s1" }, sessionOf).ok, true);
assert.equal(guestMayRun(view, { kind: "prompt", sessionId: "s1" }, sessionOf).ok, false);
assert.equal(guestMayRun(prompt, { kind: "prompt", sessionId: "s1" }, sessionOf).ok, true);
assert.equal(guestMayRun(prompt, { kind: "prompt", sessionId: "s2" }, sessionOf).ok, false);
for (const kind of ["session.new", "node.settings.set", "terminal.open.tui", "secrets.list", "session.delete", "provider.oauth.start"]) {
  assert.equal(guestMayRun(prompt, { kind, sessionId: "s1" }, sessionOf).ok, false, kind);
}
assert.equal(guestMayRun(view, { kind: "sessions.list" }, sessionOf).ok, true, "listing is allowed; the reply is cut");

// Events: their session, their replies, and a cut session list only.
assert.ok(guestEvent(view, { type: "session.event", sessionId: "s1" }));
assert.equal(guestEvent(view, { type: "session.event", sessionId: "s2" }), null);
assert.equal(guestEvent(view, { type: "approval.created", approval: { sessionId: "s2" } }), null);
assert.equal(guestEvent(view, { type: "node.settings", settings: {} }), null);
// A guest's ids run in its own namespace: its replies come back with the id it
// sent, and sending another client's id never gets that client's reply.
assert.deepEqual(guestEvent(view, { type: "models.list", requestId: guestRequestId("inv-1", "req-1") }), { type: "models.list", requestId: "req-1" }, "their own replies pass");
assert.equal(guestEvent(view, { type: "artifacts.list", requestId: "req-1" }), null, "the same id from another client stays theirs");
assert.equal(guestEvent(view, { type: "models.list", requestId: guestRequestId("inv-2", "req-1") }), null, "another guest's reply");
assert.deepEqual((guestEvent(view, { type: "sessions.list", sessions: [{ id: "s1" }, { id: "s2" }] }) as any).sessions, [{ id: "s1", guestMode: "view" }]);

// Inviting again replaces; the control plane gets no keys; expiry drops the invite and its key.
const first = invites.create({ sessionId: "s1", accountId: "bo", email: "bo@example.com", mode: "view", durationMs: 60 * 60_000 });
const second = invites.create({ sessionId: "s1", accountId: "bo", email: "bo@example.com", mode: "prompt", durationMs: 60 * 60_000 });
assert.deepEqual(invites.list().map((i) => i.id), [second.id]);
assert.notEqual(first.keyB64, second.keyB64);
assert.ok(!JSON.stringify(invites.routing()).includes(second.keyB64) && !JSON.stringify(invites.routing()).includes("bo@"));
assert.equal(invites.forAccount("bo")?.id, second.id);
now += 2 * 60 * 60_000;
assert.deepEqual(new SessionInvites(dir, () => now).list(), [], "expired invites are gone, from disk too");

// A teammate the control plane no longer routes (left the team) loses the invite.
const third = invites.create({ sessionId: "s1", accountId: "cy", email: "cy@example.com", mode: "view", durationMs: 60 * 60_000 });
invites.create({ sessionId: "s1", accountId: "bo", email: "bo@example.com", mode: "view", durationMs: 60 * 60_000 });
assert.equal(invites.keepRouted([{ accountId: "bo", sessionId: "s1" }]), 1);
assert.equal(invites.get(third.id), undefined);

console.log("session-invites: all tests passed");
