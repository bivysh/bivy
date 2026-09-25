// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import test from "node:test";
import { requiresExistingSession, resolveTargetSession } from "../src/session/target-session.js";

const targeted = { targetKind: "existing_session", targetSessionId: "s1" };
const resolvers = (open?: string, resumable?: string, snapshot = false) => ({
  open: (id: string) => (id === open ? `open:${id}` : undefined),
  resume: async (id: string) => (id === resumable ? `resumed:${id}` : undefined),
  restoreSnapshot: async () => snapshot,
});

test("scheduled Runs and Runs aimed at an existing Session are strict", () => {
  assert.equal(requiresExistingSession({ source: "schedule" }), true);
  assert.equal(requiresExistingSession({ source: "github", targetKind: "existing_session" }), true);
  assert.equal(requiresExistingSession({ source: "slack" }), false);
});

test("a strict Run continues its Session: open, resumed from disk, or restored from a snapshot", async () => {
  assert.equal(await resolveTargetSession(targeted, resolvers("s1"), true), "open:s1");
  assert.equal(await resolveTargetSession(targeted, resolvers(undefined, "s1"), true), "resumed:s1");
  let restored = false;
  const afterSnapshot = { ...resolvers(), restoreSnapshot: async () => (restored = true), resume: async (id: string) => (restored ? `resumed:${id}` : undefined) };
  assert.equal(await resolveTargetSession(targeted, afterSnapshot, true), "resumed:s1");
});

test("a strict Run fails visibly instead of cold-starting without its Session", async () => {
  await assert.rejects(resolveTargetSession(targeted, resolvers(), true), /could not continue session s1: the session is not available on this Machine/);
});

test("a best-effort follow-up falls through to a fresh pickup; untargeted items resolve to none", async () => {
  assert.equal(await resolveTargetSession(targeted, resolvers(undefined, "s1"), false), null, "non-strict does not resume a closed Session");
  assert.equal(await resolveTargetSession({ source: "slack" }, resolvers("s1"), true), null);
});
