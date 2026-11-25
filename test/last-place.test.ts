// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
// An installed app relaunched soon after it was hidden reopens that chat
// (packages/web/src/lastPlace.ts).
import assert from "node:assert/strict";
import { RESUME_WINDOW_MS, placeToResume } from "../packages/web/src/lastPlace.js";

const now = 1_800_000_000_000;
const place = { sessionId: "s1", nodeId: "n1", at: now - 5 * 60_000 };
const root = { kind: "root" } as const;

assert.deepEqual(placeToResume(root, place, now, true), place, "a bare launch soon after reopens the chat");
assert.equal(placeToResume(root, { ...place, at: now - RESUME_WINDOW_MS - 1 }, now, true), null, "after the window it starts fresh");
assert.equal(placeToResume({ kind: "session", id: "s2" }, place, now, true), null, "a link says where it wants to go");
assert.equal(placeToResume(root, place, now, false), null, "a browser tab at / is a deliberate visit");
console.log("last-place: passed");
