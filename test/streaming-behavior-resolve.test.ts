// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// resolveStreamingBehavior decides whether a follow-up prompt steers the running
// turn or starts a fresh one. The bug it guards against: defaulting to "steer" on
// the runtime's `isStreaming` alone, which can be stuck-true after a turn has
// actually ended — so a brand-new message gets injected into a dead turn and
// silently vanishes. The fix requires BOTH Bivy's authoritative `isWorking`
// and the runtime's `isStreaming`
// before defaulting to steer.
import assert from "node:assert/strict";
import test from "node:test";
import { resolveStreamingBehavior } from "../src/session/record.js";

test("an explicit client request always wins", () => {
  assert.equal(resolveStreamingBehavior("followUp", { isWorking: true, isStreaming: true }), "followUp");
  assert.equal(resolveStreamingBehavior("steer", { isWorking: false, isStreaming: false }), "steer");
});

test("defaults to steer only when a turn is genuinely in flight (both flags)", () => {
  assert.equal(resolveStreamingBehavior(undefined, { isWorking: true, isStreaming: true }), "steer");
});

test("does NOT steer when isStreaming is stuck-true but the turn has ended", () => {
  // The regression: isWorking cleared by agent_end, but the runtime's isStreaming
  // never settled. A new message must start a fresh turn, not vanish into the
  // finished one.
  assert.equal(resolveStreamingBehavior(undefined, { isWorking: false, isStreaming: true }), undefined);
});

test("does not steer when idle", () => {
  assert.equal(resolveStreamingBehavior(undefined, { isWorking: false, isStreaming: false }), undefined);
  // isWorking without an active stream also starts a fresh turn (unchanged from
  // the prior behavior, which keyed solely off isStreaming).
  assert.equal(resolveStreamingBehavior(undefined, { isWorking: true, isStreaming: false }), undefined);
});
