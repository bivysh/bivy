// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
// Machine-side team sharing rules (src/team-share.ts).
import assert from "node:assert/strict";
import type { LinkedDevice } from "../src/device-registry.js";
import { TeamPolicyError, TeamShare, teammateByDevice, teammateDevicesToRemove } from "../src/team-share.js";

const device = (id: string, teammate?: string): LinkedDevice => ({
  id, publicKeyB64: `pub-${id}`, label: id, createdAt: "", lastSeenAt: null,
  ...(teammate ? { teammate: { accountId: teammate, email: `${teammate}@example.com` } } : {}),
});
const devices = [device("own"), device("bo-phone", "bo"), device("cy-laptop", "cy")];

// Sharing off removes every teammate device and never the owner's own.
assert.deepEqual(teammateDevicesToRemove(devices, { shared: false, memberAccountIds: ["ada", "bo", "cy"] }).map((d) => d.id), ["bo-phone", "cy-laptop"]);
// Shared: only teammates who have left the team go.
assert.deepEqual(teammateDevicesToRemove(devices, { shared: true, memberAccountIds: ["ada", "bo"] }).map((d) => d.id), ["cy-laptop"]);

// "Started by" comes from the machine's own record of the device.
assert.equal(teammateByDevice(devices, "pub-bo-phone")?.email, "bo@example.com");
assert.equal(teammateByDevice(devices, "pub-own"), undefined, "the owner's sessions aren't labelled");
assert.equal(teammateByDevice(devices, "pub-unknown"), undefined);
assert.equal(teammateByDevice(devices, undefined), undefined);

// The team turns sharing off: the machine's own switch goes off and teammates go.
{
  let enabled = true;
  const revoked: string[] = [];
  const share = new TeamShare({
    request: async (_path, init) => init?.method === "PUT"
      ? new Response(JSON.stringify({ error: "Your team's admins have turned off sharing machines.", code: "team-policy" }), { status: 403 })
      : new Response(JSON.stringify({ shared: false, memberAccountIds: ["ada", "bo", "cy"] }), { status: 200 }),
    enabled: () => enabled,
    devices: () => devices,
    revoke: (id) => { revoked.push(id); },
    disable: () => { enabled = false; },
  });
  await share.check();
  assert.equal(enabled, false);
  assert.deepEqual(revoked, ["bo-phone", "cy-laptop"]);
  await assert.rejects(share.publish(), TeamPolicyError);
}

// The switch is for the team it was turned on for: when the owner's team
// changes, it turns off instead of sharing the machine with the new team.
{
  let enabled = true;
  let bound: string | undefined;
  let team: string | null = "team-a";
  const puts: string[] = [];
  const revoked: string[] = [];
  const share = new TeamShare({
    request: async (_path, init) => {
      if (init?.method === "PUT") puts.push(String(init.body));
      return new Response(JSON.stringify({ shared: init?.method === "PUT" || team === "team-a", memberAccountIds: ["ada", "bo", "cy"], teamId: team }), { status: 200 });
    },
    enabled: () => enabled,
    devices: () => devices,
    revoke: (id) => { revoked.push(id); },
    disable: () => { enabled = false; },
    boundTeam: () => bound,
    bind: (id) => { bound = id; },
  });
  await share.publish();
  assert.equal(bound, "team-a");
  team = "team-b";
  await share.check();
  assert.equal(enabled, false, "the switch turned itself off");
  assert.deepEqual(puts, [JSON.stringify({ shared: true })], "it didn't share itself into the new team");
  assert.deepEqual(revoked, ["bo-phone", "cy-laptop"]);
}

console.log("team-share: all tests passed");
