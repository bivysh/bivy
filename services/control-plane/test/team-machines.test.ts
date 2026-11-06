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
  { shared: true, memberAccountIds: [ada!.id, bo!.id].sort() },
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

console.log("team-machines: ok");
