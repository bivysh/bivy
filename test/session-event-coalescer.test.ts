// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { strict as assert } from "node:assert";
import test from "node:test";

import { SessionEventCoalescer } from "../src/session-event-coalescer.js";

// Manual timer harness: schedule() records callbacks; tick() fires all pending,
// so coalescing is exercised deterministically without real time.
function manualTimers() {
  let seq = 0;
  const scheduled = new Map<number, () => void>();
  return {
    timers: {
      schedule: (fn: () => void) => {
        const id = ++seq;
        scheduled.set(id, fn);
        return id;
      },
      cancel: (id: number) => {
        scheduled.delete(id);
      },
    },
    tick() {
      const fns = [...scheduled.values()];
      scheduled.clear();
      for (const fn of fns) fn();
    },
    pendingCount() {
      return scheduled.size;
    },
  };
}

test("coalesces a burst of updates into a single, latest emit", () => {
  const emitted: unknown[] = [];
  const clock = manualTimers();
  const c = new SessionEventCoalescer<number>({ coalesceMs: 16, emit: (p) => emitted.push(p), timers: clock.timers });

  c.push("s1", { n: 1 });
  c.push("s1", { n: 2 });
  c.push("s1", { n: 3 });

  assert.equal(emitted.length, 0, "nothing emitted before the timer fires");
  assert.equal(clock.pendingCount(), 1, "a burst schedules exactly one timer");

  clock.tick();
  assert.deepEqual(emitted, [{ n: 3 }], "only the latest (superseding) update is emitted");
});

test("flush emits the pending update immediately and cancels the timer", () => {
  const emitted: unknown[] = [];
  const clock = manualTimers();
  const c = new SessionEventCoalescer<number>({ coalesceMs: 16, emit: (p) => emitted.push(p), timers: clock.timers });

  c.push("s1", { n: 1 });
  c.flush("s1");

  assert.deepEqual(emitted, [{ n: 1 }]);
  assert.equal(clock.pendingCount(), 0, "timer cancelled after a manual flush");

  clock.tick(); // must not double-emit
  assert.equal(emitted.length, 1);
});

test("flush is a no-op when nothing is pending", () => {
  const emitted: unknown[] = [];
  const clock = manualTimers();
  const c = new SessionEventCoalescer<number>({ coalesceMs: 16, emit: (p) => emitted.push(p), timers: clock.timers });

  c.flush("s1");
  assert.equal(emitted.length, 0);
});

test("clear drops the pending update without emitting", () => {
  const emitted: unknown[] = [];
  const clock = manualTimers();
  const c = new SessionEventCoalescer<number>({ coalesceMs: 16, emit: (p) => emitted.push(p), timers: clock.timers });

  c.push("s1", { n: 1 });
  c.clear("s1");

  assert.equal(clock.pendingCount(), 0, "timer cancelled on clear");
  clock.tick();
  assert.equal(emitted.length, 0, "nothing emitted after clear");
  assert.equal(c.size, 0);
});

test("sessions coalesce independently", () => {
  const emitted: unknown[] = [];
  const clock = manualTimers();
  const c = new SessionEventCoalescer<number>({ coalesceMs: 16, emit: (p) => emitted.push(p), timers: clock.timers });

  c.push("a", { s: "a", n: 1 });
  c.push("b", { s: "b", n: 1 });
  c.push("a", { s: "a", n: 2 });

  assert.equal(clock.pendingCount(), 2, "one timer per session");
  clock.tick();
  assert.deepEqual(emitted, [{ s: "a", n: 2 }, { s: "b", n: 1 }]);
});

test("a fresh burst after flush schedules a new timer", () => {
  const emitted: unknown[] = [];
  const clock = manualTimers();
  const c = new SessionEventCoalescer<number>({ coalesceMs: 16, emit: (p) => emitted.push(p), timers: clock.timers });

  c.push("s1", { n: 1 });
  clock.tick();
  c.push("s1", { n: 2 });

  assert.equal(clock.pendingCount(), 1, "second burst re-arms the timer");
  clock.tick();
  assert.deepEqual(emitted, [{ n: 1 }, { n: 2 }]);
});
