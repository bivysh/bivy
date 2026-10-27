// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
import { strict as assert } from "node:assert";
import test from "node:test";

import { BufferBudget, forwardOrEvict, WS_OPEN } from "../src/backpressure.js";

const MARK = 16 * 1024 * 1024;
const TOTAL = 256 * 1024 * 1024;
const FRAME = 256 * 1024;
const budget = (queued = 0) => Object.assign(new BufferBudget(MARK, TOTAL, FRAME), { queued });
const frame = Buffer.from("frame");

function fakeSocket(init: { readyState?: number; bufferedAmount?: number } = {}) {
  const s = {
    readyState: init.readyState ?? WS_OPEN,
    bufferedAmount: init.bufferedAmount ?? 0,
    sent: [] as string[],
    callbacks: [] as Array<() => void>,
    terminated: false,
    send(d: Buffer, _options: { binary: boolean }, cb: () => void) {
      s.sent.push(d.toString());
      s.callbacks.push(cb);
    },
    terminate() {
      s.terminated = true;
    },
  };
  return s;
}

test("forwards when the outbound buffer is under the mark", () => {
  const ws = fakeSocket({ bufferedAmount: 1_000 });
  const result = forwardOrEvict(ws, frame, budget());
  assert.equal(result, "sent");
  assert.deepEqual(ws.sent, ["frame"]);
  assert.equal(ws.terminated, false);
});

test("evicts a slow consumer past the high-water mark and does not queue more", () => {
  const ws = fakeSocket({ bufferedAmount: 20 * 1024 * 1024 });
  const result = forwardOrEvict(ws, frame, budget());
  assert.equal(result, "evicted");
  assert.deepEqual(ws.sent, [], "must not add to an already backed-up socket");
  assert.equal(ws.terminated, true, "terminate frees the queue now; a close frame would wait behind it");
});

test("skips a socket that is not open (no send, no close)", () => {
  const ws = fakeSocket({ readyState: 3 /* CLOSED */, bufferedAmount: 0 });
  const result = forwardOrEvict(ws, frame, budget());
  assert.equal(result, "skipped");
  assert.deepEqual(ws.sent, []);
  assert.equal(ws.terminated, false);
});

test("boundary: exactly at the mark still sends (strictly greater evicts)", () => {
  const ws = fakeSocket({ bufferedAmount: MARK });
  const result = forwardOrEvict(ws, frame, budget());
  assert.equal(result, "sent");
  assert.deepEqual(ws.sent, ["frame"]);
});

test("over the relay-wide budget, a backed-up socket is evicted and a healthy one still sends", () => {
  const pressured = budget(TOTAL + 1);
  const stuck = fakeSocket({ bufferedAmount: FRAME + 1 });
  const healthy = fakeSocket({ bufferedAmount: 0 });
  assert.equal(forwardOrEvict(stuck, frame, pressured), "evicted");
  assert.equal(forwardOrEvict(healthy, frame, pressured), "sent");
  assert.deepEqual(healthy.sent, ["frame"]);
});

test("queued bytes count while a send is in flight and are released by its callback", () => {
  const b = budget();
  const ws = fakeSocket();
  forwardOrEvict(ws, frame, b);
  assert.equal(b.queued, frame.length);
  ws.callbacks[0]();
  assert.equal(b.queued, 0);
});
