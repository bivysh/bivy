// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import {
  readEphemeralTeardownConfig,
  shouldSelfTeardown,
  snapshotsDurableForTeardown,
  performSelfTeardown,
  __resetTeardownLatch,
  type EphemeralTeardownConfig,
} from "../src/ephemeral-teardown.js";

const base: EphemeralTeardownConfig = { enabled: true, provider: "fly", ttlMin: 60, onFinish: false, finishGraceMs: 10_000, idleGraceMs: 30 * 60_000 };
const quiet = { everBusy: true, anyWorking: false, anyRemoteActive: false, inFlightWork: 0 };

// Disabled (persistent node — env absent) → never self-teardown.
assert.equal(shouldSelfTeardown({ ...base, enabled: false }, { ...quiet, idleForMs: 1e9 }), false);
// Never been busy → never (don't reap a freshly-booted machine before it works).
assert.equal(shouldSelfTeardown(base, { ...quiet, everBusy: false, idleForMs: 1e9 }), false);
// Blocked by an active turn / an attached device / in-flight queue work.
assert.equal(shouldSelfTeardown(base, { ...quiet, anyWorking: true, idleForMs: 1e9 }), false);
assert.equal(shouldSelfTeardown(base, { ...quiet, anyRemoteActive: true, idleForMs: 1e9 }), false);
assert.equal(shouldSelfTeardown(base, { ...quiet, inFlightWork: 2, idleForMs: 1e9 }), false);
// Idle path: waits the full idle window.
assert.equal(shouldSelfTeardown(base, { ...quiet, idleForMs: 29 * 60_000 }), false);
assert.equal(shouldSelfTeardown(base, { ...quiet, idleForMs: 31 * 60_000 }), true);
// Finish path ("destroy when the agent finishes"): short grace.
const finish = { ...base, onFinish: true };
assert.equal(shouldSelfTeardown(finish, { ...quiet, idleForMs: 5_000 }), false);
assert.equal(shouldSelfTeardown(finish, { ...quiet, idleForMs: 11_000 }), true);

// A disposable node must not delete the only session copy unless every
// non-empty snapshot was acknowledged by durable storage.
assert.equal(snapshotsDurableForTeardown({ required: 2, persisted: 2, failed: 0 }), true);
assert.equal(snapshotsDurableForTeardown({ required: 2, persisted: 1, failed: 1 }), false);
assert.equal(snapshotsDurableForTeardown({ required: 0, persisted: 0, failed: 0 }), true);

// Config parse: provider lowercased, flags read, absent env → disabled.
const cfg = readEphemeralTeardownConfig({ BIVY_EPHEMERAL: "1", BIVY_EPHEMERAL_PROVIDER: "Hetzner", BIVY_EPHEMERAL_TTL_MIN: "120", BIVY_TEARDOWN_ON_FINISH: "1" } as NodeJS.ProcessEnv);
assert.equal(cfg.enabled, true);
assert.equal(cfg.provider, "hetzner");
assert.equal(cfg.ttlMin, 120);
assert.equal(cfg.onFinish, true);
assert.equal(readEphemeralTeardownConfig({} as NodeJS.ProcessEnv).enabled, false);

// performSelfTeardown: Fly exits (no OS shutdown); signals the CP first.
{
  __resetTeardownLatch();
  let exited = -1, shut = 0, signalled = 0;
  await performSelfTeardown({ provider: "fly", exit: (c) => { exited = c; }, shutdown: () => { shut++; }, signalSettled: async () => { signalled++; }, log: () => {} });
  assert.equal(exited, 0);
  assert.equal(shut, 0, "fly reaps on exit — no shutdown");
  assert.equal(signalled, 1);
}
// EC2 runs `shutdown -h now` (self-terminate) then exits.
{
  __resetTeardownLatch();
  let exited = -1, shut = 0;
  await performSelfTeardown({ provider: "aws", exit: (c) => { exited = c; }, shutdown: () => { shut++; }, log: () => {} });
  assert.equal(exited, 0);
  assert.equal(shut, 1);
}
// Once-only latch: a racing sweep + agent_end can both call it safely.
{
  __resetTeardownLatch();
  let calls = 0;
  await performSelfTeardown({ provider: "fly", exit: () => { calls++; }, log: () => {} });
  await performSelfTeardown({ provider: "fly", exit: () => { calls++; }, log: () => {} });
  assert.equal(calls, 1);
}

console.log("ephemeral-teardown: all tests passed");
