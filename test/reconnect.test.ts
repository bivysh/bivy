// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { strict as assert } from "node:assert";
import test from "node:test";

import { ReconnectingConnection, type ReconnectClock } from "../src/session/reconnect.js";

/** A controllable clock: timers fire only when the test says so; random is fixed
 *  at 0.5 so jittered delays collapse to their exact target. */
class FakeClock implements ReconnectClock {
  private seq = 0;
  timers = new Map<number, { fn: () => void; ms: number }>();
  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = ++this.seq;
    this.timers.set(id, { fn, ms });
    return id;
  };
  clearTimeout = (h: unknown): void => void this.timers.delete(h as number);
  random = (): number => 0.5;
  pendingDelays(): number[] {
    return [...this.timers.values()].map((t) => t.ms).sort((a, b) => a - b);
  }
  fireAll(): void {
    const fns = [...this.timers.values()].map((t) => t.fn);
    this.timers.clear();
    for (const fn of fns) fn();
  }
}

/** Flush pending microtasks (the connect promise chains) using the REAL clock. */
const tick = () => new Promise((r) => setTimeout(r, 0));

test("connect failures back off exponentially, then succeed", async () => {
  const clock = new FakeClock();
  const active: string[] = [];
  let attempts = 0;
  const conn = new ReconnectingConnection<string>({
    connect: async () => {
      attempts += 1;
      if (attempts <= 2) throw new Error("connect failed");
      return "sock";
    },
    close: () => {},
    onActive: (c) => active.push(c),
    backoff: { baseMs: 1000, factor: 2, jitter: 0.3 },
    clock,
  });

  conn.start();
  await tick(); // first attempt rejects → retry scheduled at base (1000)
  assert.deepEqual(clock.pendingDelays(), [1000]);

  clock.fireAll();
  await tick(); // second attempt rejects → retry at base*factor (2000)
  assert.deepEqual(clock.pendingDelays(), [2000]);

  clock.fireAll();
  await tick(); // third attempt succeeds
  assert.equal(conn.current(), "sock");
  assert.deepEqual(active, ["sock"]);
  assert.deepEqual(clock.pendingDelays(), [], "no retry pending once connected");
});

test("ensure() resolves with the live connection, and times out to undefined", async () => {
  const clock = new FakeClock();
  let release!: (v: string) => void;
  const gate = new Promise<string>((res) => { release = res; });
  const conn = new ReconnectingConnection<string>({
    connect: async () => gate,
    close: () => {},
    clock,
  });

  const p = conn.ensure(5000);
  await tick();
  release("sock");
  assert.equal(await p, "sock", "resolves once the connection is active");

  // A never-connecting supervisor: ensure resolves undefined when its timer fires.
  const stuck = new ReconnectingConnection<string>({
    connect: () => new Promise<string>(() => {}),
    close: () => {},
    clock,
  });
  const p2 = stuck.ensure(3000);
  await tick();
  clock.fireAll(); // fire the 3000ms ensure-timeout
  assert.equal(await p2, undefined, "times out to undefined so the caller can skip");
});

test("a drop after a healthy connection reconnects promptly (one base delay)", async () => {
  const clock = new FakeClock();
  const drops: number[] = [];
  let n = 0;
  let dropFn: (() => void) | undefined;
  const conn = new ReconnectingConnection<string>({
    connect: async (onDrop) => { dropFn = () => onDrop(); n += 1; return `sock${n}`; },
    close: () => {},
    onDrop: () => drops.push(1),
    backoff: { baseMs: 1000, factor: 2, jitter: 0 },
    clock,
  });

  conn.start();
  await tick();
  assert.equal(conn.current(), "sock1");

  dropFn!(); // the connection dies
  assert.equal(conn.current(), undefined, "current cleared on drop");
  assert.equal(drops.length, 1);
  assert.deepEqual(clock.pendingDelays(), [1000], "prompt reconnect, not a backed-off delay");

  clock.fireAll();
  await tick();
  assert.equal(conn.current(), "sock2", "reconnected");
});

test("stop() closes the live connection and prevents further reconnects", async () => {
  const clock = new FakeClock();
  let closed = 0;
  const conn = new ReconnectingConnection<string>({
    connect: async () => "sock",
    close: () => { closed += 1; },
    clock,
  });

  conn.start();
  await tick();
  assert.equal(conn.current(), "sock");

  conn.stop();
  assert.equal(closed, 1, "live connection closed");
  assert.equal(conn.current(), undefined);

  conn.start(); // no-op after stop
  await tick();
  assert.equal(conn.current(), undefined);
  assert.deepEqual(clock.pendingDelays(), []);
});
