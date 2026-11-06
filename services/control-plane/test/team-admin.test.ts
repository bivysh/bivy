// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { createPgMemStore } from "../src/pg-mem-store.js";
import { DEFAULT_TEAM_POLICIES, PostgresTeamAdmin } from "../src/team-admin.js";
import { normalizeTeamInvite } from "../src/teams.js";

const store = createPgMemStore();
await store.init();
const ada = await store.findOrCreateAccount("ada@example.com");
const bo = await store.findOrCreateAccount("bo@example.com");
const { team } = await store.teams.createTeam(ada.id, "Acme");
const { token } = await store.teams.createInvite(team.id, ada.id, normalizeTeamInvite({}));
await store.teams.acceptInvite(token, bo);
await store.enrollNode(ada.id, "ada-box", "ada-box");
const admin = store.teamAdmin;
const later = new Date(Date.now() + 60 * 60_000).toISOString();

// Everything is allowed until an admin says otherwise.
assert.deepEqual(await admin.policies(team.id), DEFAULT_TEAM_POLICIES);
assert.deepEqual(await admin.policiesForNode("ada-box"), DEFAULT_TEAM_POLICIES);

// Turning a policy off ends what it allowed at once; the other stays.
await store.teamMachines.setShared("ada-box", true);
await store.teamMachines.setInvites("ada-box", [{ accountId: bo.id, sessionId: "s1", mode: "view", expiresAt: later }]);
assert.equal((await store.teamMachines.access(bo.id, "ada-box"))?.kind, "teammate");
await admin.setPolicies(team.id, { shareMachines: false });
assert.equal(await store.teamMachines.isShared("ada-box"), false);
assert.deepEqual(await store.teamMachines.access(bo.id, "ada-box"), { kind: "teammate", ownerAccountId: ada.id, guest: true }, "invites stay");
await admin.setPolicies(team.id, { sessionInvites: false });
assert.equal(await store.teamMachines.access(bo.id, "ada-box"), undefined);
assert.deepEqual(await admin.policiesForNode("ada-box"), { shareMachines: false, sessionInvites: false });

// The log is newest first, labelled, and keeps a bounded tail per team.
await admin.record(team.id, "ada@example.com", "member.role", { email: "bo@example.com", role: "admin" });
await admin.record(team.id, "bo@example.com", "member.left");
const events = await admin.audit(team.id);
assert.deepEqual(events.map((e) => [e.actorEmail, e.action, e.label]), [["bo@example.com", "member.left", "Left"], ["ada@example.com", "member.role", "Changed a role"]]);
assert.deepEqual(events[1]!.detail, { email: "bo@example.com", role: "admin" });
const small = new PostgresTeamAdmin((store as unknown as { database: ConstructorParameters<typeof PostgresTeamAdmin>[0] }).database, 3);
for (let i = 0; i < 6; i++) await small.record(team.id, "ada@example.com", "invite.created", { n: i });
assert.deepEqual((await small.audit(team.id, 500)).map((e) => e.detail.n), [5, 4, 3], "only the newest are kept");

// Deleting the team takes its policies and log with it.
await store.teams.deleteTeam(team.id);
assert.deepEqual(await admin.audit(team.id), []);
assert.deepEqual(await admin.policies(team.id), DEFAULT_TEAM_POLICIES);

console.log("team-admin: ok");
