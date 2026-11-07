// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { createPgMemStore } from "../src/pg-mem-store.js";
import { normalizeTeamInvite } from "../src/teams.js";

const store = createPgMemStore();
await store.init();
const [ada, bo, eve] = await Promise.all(["ada@example.com", "bo@example.com", "eve@example.com"].map((e) => store.findOrCreateAccount(e)));
const { team } = await store.teams.createTeam(ada.id, "Acme");
const { token } = await store.teams.createInvite(team.id, ada.id, normalizeTeamInvite({}));
await store.teams.acceptInvite(token, bo!);
await store.enrollNode(ada!.id, "ada-box", "ada-box");
await store.enrollNode(ada!.id, "ada-laptop", "ada-laptop");
await store.enrollNode(eve!.id, "eve-box", "eve-box");
const machines = store.teamMachines;

// Nothing is shared until the machine says so.
assert.deepEqual(await machines.sharedWith(bo!.id), []);
assert.equal(await machines.access(bo!.id, "ada-box"), undefined);
assert.deepEqual(await machines.access(ada!.id, "ada-box"), { kind: "owner", ownerAccountId: ada!.id });

// Shared: teammates see and reach that one machine; outsiders don't.
await machines.setShared("ada-box", true);
assert.deepEqual(await machines.sharedWith(bo!.id), [{ nodeId: "ada-box", ownerAccountId: ada!.id, ownerEmail: "ada@example.com" }]);
assert.deepEqual(await machines.access(bo!.id, "ada-box"), { kind: "teammate", ownerAccountId: ada!.id });
assert.equal(await machines.access(bo!.id, "ada-laptop"), undefined, "only the shared machine");
assert.equal(await machines.access(eve!.id, "ada-box"), undefined, "not outside the team");
assert.deepEqual(await machines.sharedWith(ada!.id), [], "your own machines aren't listed as shared with you");
assert.deepEqual(
  { ...(await machines.shareState("ada-box")), memberAccountIds: (await machines.shareState("ada-box")).memberAccountIds.sort() },
  { shared: true, memberAccountIds: [ada!.id, bo!.id].sort(), teamId: team.id },
);

// Leaving the team ends access at once, without the machine changing anything.
await store.teams.removeMember(team.id, bo!.id);
assert.equal(await machines.access(bo!.id, "ada-box"), undefined);
assert.deepEqual((await machines.shareState("ada-box")).memberAccountIds, [ada!.id]);

// Turning sharing off, or removing the machine, ends it too.
await store.teams.acceptInvite(token, bo!);
await machines.setShared("ada-box", false);
assert.equal(await machines.access(bo!.id, "ada-box"), undefined);
await machines.setShared("ada-box", true);
await store.removeNode(ada!.id, "ada-box");
assert.deepEqual(await machines.sharedWith(bo!.id), []);

// Session invites: routing only, for current teammates; a guest reaches the
// machine without it being shared, and loses it on leaving.
await store.enrollNode(ada!.id, "ada-box2", "ada-box2");
const later = new Date(Date.now() + 60 * 60_000).toISOString();
const kept = await machines.setInvites("ada-box2", [
  { accountId: bo!.id, sessionId: "s1", mode: "view", expiresAt: later },
  { accountId: eve!.id, sessionId: "s1", mode: "prompt", expiresAt: later },
  { accountId: bo!.id, sessionId: "s2", mode: "prompt", expiresAt: new Date(Date.now() - 1000).toISOString() },
]);
assert.deepEqual(kept.map((i) => [i.accountId, i.sessionId]), [[bo!.id, "s1"]], "outsiders and expired invites are dropped");
assert.deepEqual((await machines.invitedTo(bo!.id)).map((m) => [m.nodeId, m.sessions]), [["ada-box2", 1]]);
assert.deepEqual(await machines.access(bo!.id, "ada-box2"), { kind: "teammate", ownerAccountId: ada!.id, guest: true });
assert.equal(await machines.access(eve!.id, "ada-box2"), undefined);
await store.teams.removeMember(team.id, bo!.id);
assert.equal(await machines.access(bo!.id, "ada-box2"), undefined, "leaving the team ends the invite");

// A machine is shared with the team its owner was in: leaving ends it, so it
// doesn't carry into the owner's next team.
{
  const [cy, dee] = await Promise.all(["cy@example.com", "dee@example.com"].map((e) => store.findOrCreateAccount(e)));
  const { team: first } = await store.teams.createTeam(cy!.id, "First");
  await store.teams.acceptInvite((await store.teams.createInvite(first.id, cy!.id, normalizeTeamInvite({ role: "admin" }))).token, dee!);
  await store.enrollNode(cy!.id, "cy-box", "cy-box");
  await machines.setShared("cy-box", true);
  assert.equal((await machines.shareState("cy-box")).teamId, first.id);
  await store.teams.removeMember(first.id, cy!.id);
  const { team: next } = await store.teams.createTeam(eve!.id, "Next");
  await store.teams.acceptInvite((await store.teams.createInvite(next.id, eve!.id, normalizeTeamInvite({}))).token, cy!);
  assert.equal(await machines.access(eve!.id, "cy-box"), undefined, "not shared with the new team");
  assert.deepEqual(await machines.shareState("cy-box"), { shared: false, memberAccountIds: (await machines.shareState("cy-box")).memberAccountIds, teamId: next.id });
}

console.log("team-machines: ok");
