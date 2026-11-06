// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
// Team invite landing (`/team/join#tin_…`, packages/web/src/teamInvite.ts):
// the token is stashed and the URL becomes /settings/team with no hash, so
// the controller never reads the token as a device-link payload.
import assert from "node:assert/strict";
import { applyTeamInvite, clearTeamInvite, peekTeamInvite } from "../packages/web/src/teamInvite.js";

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

const token = "tin_Nhy1_feXDzonKA85SW3-wSAhuNcerphC";
const storage = new MemoryStorage();
assert.equal(applyTeamInvite("/sessions/new", `#${token}`, storage), null, "other routes are untouched");
assert.equal(applyTeamInvite("/team/join/", `#${token}`, storage), "/settings/team");
assert.equal(peekTeamInvite(storage), token);
clearTeamInvite(storage);
assert.equal(peekTeamInvite(storage), null);
// A malformed fragment still lands on the Team panel but stashes nothing.
assert.equal(applyTeamInvite("/team/join", "#eyJzZXNzaW9uIjoi", storage), "/settings/team");
assert.equal(peekTeamInvite(storage), null);

console.log("team-invite-landing: all tests passed");
