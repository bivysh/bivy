// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Characterization tests for the turn-watchdog orchestration extracted from
// server.ts. Before the extraction this logic was un-unit-testable (it only ran
// inside a booted daemon reaching into module-global state). It now takes a
// narrow WatchdogSession and an explicit deps object, so we can drive arm →
// timeout → recover and the stall sweep with fakes and a controllable clock.
import { strict as assert } from "node:assert";
import test, { mock } from "node:test";

import { createTurnWatchdog, type WatchdogSession, type WatchdogDeps } from "../src/session/turn-watchdog-runtime.js";

type FakeRecord = WatchdogSession & { busy?: boolean; pending?: boolean };

function fakeRecord(over: Partial<FakeRecord> = {}): FakeRecord {
  return {
    id: over.id ?? "s1",
    runtimeId: over.runtimeId ?? "claude-code-sdk",
    // agentServiceAddress set → probeTurnPidAlive returns undefined without ever
    // touching process.kill, keeping the stall decision purely time-based.
    agentServiceAddress: over.agentServiceAddress ?? "unix:/tmp/a.sock",
    session: over.session ?? { prompt: async () => {}, activePid: () => undefined },
    ...over,
  };
}

/** A deps bag that records what the watchdog did, so tests assert on effects. */
function harness(config?: Partial<WatchdogDeps>, clock?: { at: number }) {
  const aborted: string[] = [];
  const failed: string[] = [];
  const broadcasts: any[] = [];
  const notifications: string[] = [];
  const deps: WatchdogDeps = {
    turnTimeoutMs: config?.turnTimeoutMs ?? 0,
    turnStallMs: config?.turnStallMs ?? 0,
    turnActivityStallMs: config?.turnActivityStallMs ?? 0,
    stallAction: config?.stallAction ?? "recover",
    broadcast: (p) => broadcasts.push(p),
    broadcastSessionState: () => {},
    notifyTurnAttention: (_record, message) => notifications.push(message),
    markSessionFailed: (id) => failed.push(id),
    abortSessionRecord: (r) => aborted.push(r.id),
    evaluateEphemeralTeardown: () => {},
    sessionBusy: (r) => Boolean((r as FakeRecord).busy),
    sessionHasPendingApproval: (r) => Boolean((r as FakeRecord).pending),
    listSessions: config?.listSessions ?? (() => []),
    now: clock ? () => clock.at : undefined,
  };
  return { deps, aborted, failed, broadcasts, notifications, watchdog: createTurnWatchdog(deps) };
}

test("wall-clock timeout arms, fires, and force-recovers the turn", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { watchdog, aborted, failed, broadcasts } = harness({ turnTimeoutMs: 1000 });
    const record = fakeRecord({ workingStartedAt: 0 });

    watchdog.armTurnWatchdog(record);
    assert.equal(record.turnTimedOut, false, "arming resets the timed-out flag");
    assert.ok(record.turnWatchdog, "timer is armed");
    assert.ok(record.turnTimeoutSignal, "a timeout signal is exposed for promptWithWatchdog's race");

    mock.timers.tick(1000);

    assert.equal(record.turnTimedOut, true, "the turn is marked recovered");
    assert.deepEqual(aborted, ["s1"], "recovery ran the abort→reopen path exactly once");
    assert.deepEqual(failed, ["s1"], "the session was marked failed in metadata");
    assert.ok(broadcasts.some((b) => b.type === "session.failed"), "clients got a session.failed");
    assert.equal(watchdog.turnRecoveryStats()["claude-code-sdk:wall_clock"], 1, "recovery attributed to wall_clock");
  } finally {
    mock.timers.reset();
  }
});

test("recoverStuckTurn is idempotent while a recovery is in flight", () => {
  const { watchdog, aborted } = harness({ turnTimeoutMs: 1000 });
  const record = fakeRecord();

  watchdog.recoverStuckTurn(record, "first");
  watchdog.recoverStuckTurn(record, "second");

  assert.deepEqual(aborted, ["s1"], "the second call is a no-op — no double abort");
  assert.equal(watchdog.turnRecoveryStats()["claude-code-sdk:stalled"], 1, "counted once");
});

test("recovery settlement duration is measured against the 10s SLO", async () => {
  const clock = { at: 1_000 };
  let settle!: () => void;
  const recovery = new Promise<void>((resolve) => { settle = resolve; });
  const { watchdog } = harness({ abortSessionRecord: () => recovery }, clock);
  watchdog.recoverStuckTurn(fakeRecord(), "stuck", { trigger: "wedged" });
  assert.deepEqual(watchdog.turnRecoverySloStats(), {}, "an in-flight recovery is not reported as settled");
  clock.at += 7_500;
  settle();
  await recovery;
  await Promise.resolve();
  assert.deepEqual(watchdog.turnRecoverySloStats()["claude-code-sdk:wedged"], {
    observations: 1, totalMs: 7_500, maxMs: 7_500, withinTarget: 1, targetMs: 10_000,
  });
});

test("sweep recovers a silence-stalled turn and skips healthy/blocked ones", () => {
  const clock = { at: 10 * 60_000 }; // 10 min in
  const stalled = fakeRecord({ id: "stalled", busy: true, lastProgressAt: 0 }); // 10 min idle
  const fresh = fakeRecord({ id: "fresh", busy: true, lastProgressAt: 10 * 60_000 }); // just progressed
  const paused = fakeRecord({ id: "paused", busy: true, lastProgressAt: 0, paused: true });
  const waiting = fakeRecord({ id: "waiting", busy: true, lastProgressAt: 0, pending: true });
  const idle = fakeRecord({ id: "idle", busy: false, lastProgressAt: 0 }); // no turn running
  const all = [stalled, fresh, paused, waiting, idle];

  const { watchdog, aborted } = harness(
    { turnStallMs: 5 * 60_000, listSessions: () => all },
    clock,
  );

  watchdog.sweepStalledTurns();

  assert.deepEqual(aborted, ["stalled"], "only the genuinely stalled turn is recovered");
  assert.equal(watchdog.turnRecoveryStats()["claude-code-sdk:stalled"], 1);
});

test("notify mode flags a soft stall without killing it and lets the user continue", () => {
  const clock = { at: 10 * 60_000 };
  const record = fakeRecord({ busy: true, lastProgressAt: 0 });
  const { watchdog, aborted, broadcasts, notifications } = harness(
    { turnStallMs: 5 * 60_000, stallAction: "notify", listSessions: () => [record] },
    clock,
  );

  watchdog.sweepStalledTurns();
  watchdog.sweepStalledTurns();

  assert.deepEqual(aborted, [], "a soft stall is not force-killed");
  assert.equal(record.turnAttention?.trigger, "stalled");
  assert.equal(notifications.length, 1, "the pending review gates duplicate pushes");
  assert.equal(broadcasts.filter((b) => b.type === "session.turn_attention").length, 1);

  clock.at += 100;
  watchdog.resolveTurnAttention(record, "continue");
  assert.equal(record.turnAttention, undefined);
  assert.equal(record.lastProgressAt, clock.at, "continue resets the stall window");
  assert.ok(broadcasts.some((b) => b.type === "session.turn_attention.resolved"));
});

test("stop on a pending review runs the normal force-recovery path", () => {
  const clock = { at: 10 * 60_000 };
  const record = fakeRecord({ busy: true, lastProgressAt: 0 });
  const { watchdog, aborted } = harness(
    { turnStallMs: 5 * 60_000, stallAction: "notify", listSessions: () => [record] },
    clock,
  );
  watchdog.sweepStalledTurns();
  watchdog.resolveTurnAttention(record, "stop");
  assert.deepEqual(aborted, ["s1"]);
  assert.equal(record.turnAttention, undefined);
});

test("wedged attention clears only on structural progress", () => {
  const record = fakeRecord({ turnAttention: { trigger: "wedged", idleMs: 10, at: 1 } });
  const { watchdog } = harness();
  watchdog.clearTurnAttentionOnProgress(record, false);
  assert.ok(record.turnAttention, "raw tool output does not dismiss a wedged warning");
  watchdog.clearTurnAttentionOnProgress(record, true);
  assert.equal(record.turnAttention, undefined);
});

test("sweep is a no-op when both stall bands are disabled", () => {
  const record = fakeRecord({ id: "x", busy: true, lastProgressAt: 0 });
  const { watchdog, aborted } = harness(
    { turnStallMs: 0, turnActivityStallMs: 0, listSessions: () => [record] },
    { at: 60 * 60_000 },
  );
  watchdog.sweepStalledTurns();
  assert.deepEqual(aborted, [], "stall detection disabled → nothing recovered");
});

test("stallTriggerFor reports wedged when structural progress stalls but output flows", () => {
  const clock = { at: 20 * 60_000 };
  // lastProgressAt is recent (raw output still flowing) but structural progress
  // is 20 min stale — the chatty-but-hung tool case.
  const record = fakeRecord({ id: "w", busy: true, lastProgressAt: 20 * 60_000, lastStructuralProgressAt: 0 });
  const { watchdog } = harness(
    { turnStallMs: 5 * 60_000, turnActivityStallMs: 15 * 60_000 },
    clock,
  );
  assert.equal(watchdog.stallTriggerFor(record), "wedged");
});
