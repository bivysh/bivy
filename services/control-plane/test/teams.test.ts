// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { createPgMemStore } from "../src/pg-mem-store.js";
import { normalizeTeamInvite, TeamError } from "../src/teams.js";

async function setup() {
  const store = createPgMemStore();
  await store.init();
  const [ada, bo, cy] = await Promise.all(["ada@example.com", "bo@example.com", "cy@example.com"].map((e) => store.findOrCreateAccount(e)));
  return { store, teams: store.teams, ada: ada!, bo: bo!, cy: cy! };
}

const code = (error: unknown) => (error instanceof TeamError ? error.code : String(error));
async function rejects(promise: Promise<unknown>, expected: string) {
  await assert.rejects(promise, (error) => code(error) === expected);
}

// Creating makes the creator the admin; an account is in at most one team.
{
  const { teams, ada } = await setup();
  const created = await teams.createTeam(ada.id, "  Acme   Labs ");
  assert.equal(created.team.name, "Acme Labs");
  assert.equal(created.role, "admin");
  assert.deepEqual(await teams.teamOf(ada.id), created);
  await rejects(teams.createTeam(ada.id, "Second"), "already-in-team");
  await rejects(teams.createTeam(ada.id, " "), "invalid-name");
}

// A link invite admits several people until it runs out; reopening it as a
// member spends no use; an account in another team can't take it.
{
  const { teams, ada, bo, cy } = await setup();
  const { team } = await teams.createTeam(ada.id, "Acme");
  const { token } = await teams.createInvite(team.id, ada.id, normalizeTeamInvite({ maxUses: 2 }));
  assert.deepEqual(
    { ...(await teams.previewInvite(token)), expiresAt: undefined },
    { teamId: team.id, teamName: "Acme", role: "member", invitedBy: "ada@example.com", expiresAt: undefined },
  );
  assert.equal((await teams.acceptInvite(token, bo)).role, "member");
  assert.equal((await teams.acceptInvite(token, bo)).team.id, team.id);
  assert.equal((await teams.listInvites(team.id))[0]?.uses, 1);

  const other = await teams.createTeam(cy.id, "Other");
  await rejects(teams.acceptInvite(token, cy), "already-in-team");
  await teams.removeMember(other.team.id, cy.id);
  await teams.acceptInvite(token, cy);
  assert.equal(await teams.previewInvite(token), undefined, "used up");
  assert.deepEqual((await teams.listMembers(team.id)).map((m) => m.email), ["ada@example.com", "bo@example.com", "cy@example.com"]);
}

// An email invite is single-use and opens only for its address; a revoked
// or expired invite opens for no one.
{
  const { teams, ada, bo, cy } = await setup();
  const { team } = await teams.createTeam(ada.id, "Acme");
  const emailInvite = normalizeTeamInvite({ email: " Bo@Example.com ", role: "admin", maxUses: 9 });
  assert.equal(emailInvite.maxUses, 1);
  const { token } = await teams.createInvite(team.id, ada.id, emailInvite);
  await rejects(teams.acceptInvite(token, cy), "invite-email-mismatch");
  assert.equal((await teams.acceptInvite(token, bo)).role, "admin");

  const revoked = await teams.createInvite(team.id, ada.id, normalizeTeamInvite({}));
  assert.equal(await teams.revokeInvite(team.id, revoked.invite.id), true);
  await rejects(teams.acceptInvite(revoked.token, cy), "invite-unavailable");
  const expired = await teams.createInvite(team.id, ada.id, { role: "member", ttlMs: -1, maxUses: 1 });
  await rejects(teams.acceptInvite(expired.token, cy), "invite-unavailable");
  await rejects(teams.acceptInvite("not-a-token", cy), "invite-unavailable");
}

// A team always keeps an admin: the last admin can't step down or leave while
// others remain; the last member leaving ends the team.
{
  const { teams, ada, bo } = await setup();
  const { team } = await teams.createTeam(ada.id, "Acme");
  const { token } = await teams.createInvite(team.id, ada.id, normalizeTeamInvite({}));
  await teams.acceptInvite(token, bo);
  await rejects(teams.setMemberRole(team.id, ada.id, "member"), "last-admin");
  await rejects(teams.removeMember(team.id, ada.id), "last-admin");
  await teams.setMemberRole(team.id, bo.id, "admin");
  assert.deepEqual(await teams.removeMember(team.id, ada.id), { teamDeleted: false });
  assert.deepEqual(await teams.removeMember(team.id, bo.id), { teamDeleted: true });
  assert.equal(await teams.teamOf(bo.id), undefined);
  assert.equal(await teams.countMembers(team.id), 0);
}

// Deleting the last admin's account hands admin to the longest-serving member.
{
  const { store, teams, ada, bo, cy } = await setup();
  const { team } = await teams.createTeam(ada.id, "Acme");
  const { token } = await teams.createInvite(team.id, ada.id, normalizeTeamInvite({}));
  await teams.acceptInvite(token, bo);
  await teams.acceptInvite(token, cy);
  await store.deleteAccount(ada.id);
  assert.deepEqual((await teams.listMembers(team.id)).map((m) => [m.email, m.role]), [["bo@example.com", "admin"], ["cy@example.com", "member"]]);
}

console.log("teams: ok");
