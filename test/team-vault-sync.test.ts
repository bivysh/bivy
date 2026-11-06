// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
// Team vault, machine side (src/team-vault.ts), against a small stand-in for
// the control plane's /node/team-vault routes: an admin's machine writes, a
// member's machine asks for the key and opens the instructions, a removed
// member stops getting new ones, and sessions receive them.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deriveWrapKey, generatePairingKeypair } from "../src/pairing-crypto.js";
import { seal, open } from "../src/e2e.js";
import { TeamVaultSync, readTeamInstructions } from "../src/team-vault.js";
import { composeAgentInstructions, sessionInstructions } from "../src/agent-instructions.js";

type Wrapped = { wrappedKey: string; wrappedByPublicKey: string; keyGeneration: number };
const server = {
  members: new Map<string, "admin" | "member">([["ada", "admin"], ["bo", "member"]]),
  vault: undefined as undefined | { ciphertext: string; generation: number; keyGeneration: number; needsRotation: boolean },
  keys: new Map<string, Wrapped>(),
  requests: new Map<string, string>(),
};
const account = (nodeId: string) => nodeId.split("-")[0]!;

function handle(nodeId: string, pathname: string, init: RequestInit = {}): unknown {
  const role = server.members.get(account(nodeId));
  const body = init.body ? JSON.parse(String(init.body)) : {};
  if (pathname === "/node/team-vault" && !init.method) {
    if (!role) return { team: null };
    const requests = [...server.requests].filter(([id]) => id !== nodeId && server.members.has(account(id))).map(([id, publicKey]) => ({ nodeId: id, publicKey }));
    return { team: { id: "team_1", name: "Acme" }, role, vault: server.vault, wrappedKey: server.keys.get(nodeId), requests };
  }
  if (pathname === "/node/team-vault") {
    assert.equal(role, "admin");
    const current = server.vault;
    assert.equal(body.expectedGeneration, current?.generation ?? 0);
    if (current?.needsRotation) assert.equal(body.freshKey, true);
    const keyGeneration = !current ? 1 : current.keyGeneration + (body.freshKey ? 1 : 0);
    server.vault = { ciphertext: body.ciphertext, generation: (current?.generation ?? 0) + 1, keyGeneration, needsRotation: false };
    if (body.freshKey) for (const [id, key] of server.keys) if (key.keyGeneration < keyGeneration) server.keys.delete(id);
    return { vault: server.vault };
  }
  if (pathname === "/node/team-vault/key-request") { server.requests.set(nodeId, body.publicKey); return { ok: true }; }
  if (pathname === "/node/team-vault/key") {
    assert.ok(server.members.has(account(body.targetNodeId)), "sealed only for team machines");
    server.keys.set(body.targetNodeId, { wrappedKey: body.wrappedKey, wrappedByPublicKey: body.wrappedByPublicKey, keyGeneration: body.keyGeneration });
    server.requests.delete(body.targetNodeId);
    return { ok: true };
  }
  throw new Error(`unexpected ${pathname}`);
}

function machine(nodeId: string) {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), `team-vault-${nodeId}-`));
  const pair = generatePairingKeypair();
  const sync = new TeamVaultSync({
    appDir, nodeId,
    request: async (pathname, init) => new Response(JSON.stringify(handle(nodeId, pathname, init)), { status: 200 }),
    publicKey: () => pair.publicKeyB64,
    wrap: (pub, keyB64) => seal(deriveWrapKey(pair.privateKeyB64, pub, "team-vault"), keyB64),
    unwrap: (pub, wrapped) => open(deriveWrapKey(pair.privateKeyB64, pub, "team-vault"), wrapped),
  });
  return { appDir, sync };
}

const ada = machine("ada-laptop");
const bo = machine("bo-laptop");

// The admin writes; the ciphertext is all the server sees.
await ada.sync.sync();
await ada.sync.write("Use pnpm.", 0);
assert.ok(server.vault && !server.vault.ciphertext.includes("pnpm"));

// The member's machine has no key yet: it asks, the admin's machine answers, it opens.
await bo.sync.sync();
assert.equal(bo.sync.current().state, "waiting-for-key");
await ada.sync.sync();
await bo.sync.sync();
assert.equal(bo.sync.current().state, "ready");
assert.equal(readTeamInstructions(bo.appDir)?.text, "Use pnpm.");

// A member can't write.
await assert.rejects(bo.sync.write("Use npm.", 1), /Only a team admin/);

// Sessions get the Bivy note, then the team's, then the user's own (which win).
const composed = composeAgentInstructions("Prefer tabs.", false, "", { name: "Acme", text: "Use pnpm." });
assert.ok(composed.indexOf("Use pnpm.") < composed.indexOf("Prefer tabs."));
assert.match(composed, /the user's team \(Acme\)/);
assert.match(sessionInstructions(bo.appDir)?.text ?? "", /Use pnpm\./);

// Bo leaves: the server flags the vault; the admin's machine moves it onto a
// fresh key on its next tick, so Bo's cached key opens nothing new.
server.members.delete("bo");
server.keys.delete("bo-laptop");
server.vault!.needsRotation = true;
await ada.sync.sync();
assert.equal(server.vault!.keyGeneration, 2);
await ada.sync.write("Use pnpm 10.", server.vault!.generation);
await bo.sync.sync();
assert.equal(bo.sync.current().state, "none");
assert.equal(readTeamInstructions(bo.appDir), undefined, "a machine that left forgets the team's instructions");
assert.doesNotMatch(sessionInstructions(bo.appDir)?.text ?? "", /pnpm/, "and its sessions stop receiving them");

console.log("team-vault-sync: all tests passed");
