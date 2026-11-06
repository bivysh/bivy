// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
// Machine-side team sharing rules (src/team-share.ts).
import assert from "node:assert/strict";
import type { LinkedDevice } from "../src/device-registry.js";
import { teammateByDevice, teammateDevicesToRemove } from "../src/team-share.js";

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

console.log("team-share: all tests passed");
