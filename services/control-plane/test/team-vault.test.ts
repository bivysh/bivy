// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { createPgMemStore } from "../src/pg-mem-store.js";
import { TeamVaultError } from "../src/team-vault.js";
import { normalizeTeamInvite } from "../src/teams.js";

async function setup() {
  const store = createPgMemStore();
  await store.init();
  const ada = await store.findOrCreateAccount("ada@example.com");
  const bo = await store.findOrCreateAccount("bo@example.com");
  const eve = await store.findOrCreateAccount("eve@example.com");
  const { team } = await store.teams.createTeam(ada.id, "Acme");
  const { token } = await store.teams.createInvite(team.id, ada.id, normalizeTeamInvite({}));
  await store.teams.acceptInvite(token, bo);
  for (const [account, node] of [[ada, "ada-laptop"], [bo, "bo-laptop"], [eve, "eve-laptop"]] as const) {
    await store.enrollNode(account.id, node, node);
  }
  return { store, vault: store.teamVault, teamId: team.id, ada, bo };
}

const code = (error: unknown) => (error instanceof TeamVaultError ? error.code : String(error));
const rejects = (promise: Promise<unknown>, expected: string) => assert.rejects(promise, (e) => code(e) === expected);
const wrap = (keyGeneration: number) => ({ wrappedKey: "sealed", wrappedByPublicKey: "pub-ada", keyGeneration });

// Writes are compare-and-set on the generation the writer read.
{
  const { vault, teamId } = await setup();
  const first = await vault.write(teamId, "ada-laptop", { ciphertext: "c1", expectedGeneration: 0, freshKey: true });
  assert.deepEqual([first.generation, first.keyGeneration], [1, 1]);
  await rejects(vault.write(teamId, "ada-laptop", { ciphertext: "c2", expectedGeneration: 0, freshKey: false }), "stale");
  const second = await vault.write(teamId, "ada-laptop", { ciphertext: "c2", expectedGeneration: 1, freshKey: false });
  assert.deepEqual([second.generation, second.keyGeneration, second.ciphertext], [2, 1, "c2"]);
}

// A machine asks for the key; only team machines' requests are listed, and
// the key can be sealed only for a team machine.
{
  const { vault, teamId } = await setup();
  await vault.write(teamId, "ada-laptop", { ciphertext: "c1", expectedGeneration: 0, freshKey: true });
  await vault.requestKey(teamId, "bo-laptop", "pub-bo");
  await vault.requestKey(teamId, "eve-laptop", "pub-eve");
  assert.deepEqual((await vault.snapshot(teamId, "ada-laptop")).requests, [{ nodeId: "bo-laptop", publicKey: "pub-bo" }]);
  await rejects(vault.putWrappedKey(teamId, "ada-laptop", "eve-laptop", wrap(1)), "not-a-team-machine");
  await rejects(vault.putWrappedKey(teamId, "ada-laptop", "bo-laptop", wrap(0)), "stale-key");
  await vault.putWrappedKey(teamId, "ada-laptop", "bo-laptop", wrap(1));
  const bo = await vault.snapshot(teamId, "bo-laptop");
  assert.equal(bo.wrappedKey?.wrappedKey, "sealed");
  assert.equal(bo.vault?.ciphertext, "c1");
  assert.deepEqual((await vault.snapshot(teamId, "ada-laptop")).requests, [], "an answered request is cleared");
  // Bo's machine holds a working copy and hasn't asked again: another
  // machine can't replace it. Bo can still re-seal for itself.
  await rejects(vault.putWrappedKey(teamId, "ada-laptop", "bo-laptop", { ...wrap(1), wrappedKey: "garbage" }), "not-requested");
  assert.equal((await vault.snapshot(teamId, "bo-laptop")).wrappedKey?.wrappedKey, "sealed");
  await vault.putWrappedKey(teamId, "bo-laptop", "bo-laptop", { ...wrap(1), wrappedKey: "resealed" });
  assert.equal((await vault.snapshot(teamId, "bo-laptop")).wrappedKey?.wrappedKey, "resealed");
}

// A member who held the key leaving forces the next write onto a fresh key,
// which drops every wrap of the old one.
{
  const { store, vault, teamId, bo } = await setup();
  await vault.write(teamId, "ada-laptop", { ciphertext: "c1", expectedGeneration: 0, freshKey: true });
  await vault.putWrappedKey(teamId, "ada-laptop", "ada-laptop", wrap(1));
  await vault.putWrappedKey(teamId, "bo-laptop", "bo-laptop", wrap(1));
  await store.teams.removeMember(teamId, bo.id);
  assert.equal((await vault.snapshot(teamId, "ada-laptop")).vault?.needsRotation, true);
  await rejects(vault.write(teamId, "ada-laptop", { ciphertext: "c2", expectedGeneration: 1, freshKey: false }), "rotation-required");
  const rotated = await vault.write(teamId, "ada-laptop", { ciphertext: "c2", expectedGeneration: 1, freshKey: true });
  assert.deepEqual([rotated.keyGeneration, rotated.needsRotation], [2, false]);
  assert.equal((await vault.snapshot(teamId, "ada-laptop")).wrappedKey, undefined, "the old wrap is gone");
}

// Removing a machine that held the key also flags the vault.
{
  const { store, vault, teamId, bo } = await setup();
  await vault.write(teamId, "ada-laptop", { ciphertext: "c1", expectedGeneration: 0, freshKey: true });
  await vault.putWrappedKey(teamId, "bo-laptop", "bo-laptop", wrap(1));
  await store.removeNode(bo.id, "bo-laptop");
  assert.equal((await vault.snapshot(teamId, "ada-laptop")).vault?.needsRotation, true);
}

console.log("team-vault: ok");
