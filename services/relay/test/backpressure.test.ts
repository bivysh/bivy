// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { strict as assert } from "node:assert";
import test from "node:test";

import { forwardOrEvict, WS_OPEN, WS_SLOW_CONSUMER_CODE } from "../src/backpressure.js";

const MARK = 16 * 1024 * 1024;

function fakeSocket(init: { readyState?: number; bufferedAmount?: number } = {}) {
  const s = {
    readyState: init.readyState ?? WS_OPEN,
    bufferedAmount: init.bufferedAmount ?? 0,
    sent: [] as string[],
    closed: undefined as { code: number; reason: string } | undefined,
    terminated: false,
    send(d: string) {
      s.sent.push(d);
    },
    close(code: number, reason: string) {
      s.closed = { code, reason };
    },
    terminate() {
      s.terminated = true;
    },
  };
  return s;
}

test("forwards when the outbound buffer is under the mark", () => {
  const ws = fakeSocket({ bufferedAmount: 1_000 });
  const result = forwardOrEvict(ws, "frame", MARK);
  assert.equal(result, "sent");
  assert.deepEqual(ws.sent, ["frame"]);
  assert.equal(ws.closed, undefined);
});

test("evicts a slow consumer past the high-water mark and does not queue more", () => {
  const ws = fakeSocket({ bufferedAmount: 20 * 1024 * 1024 });
  const result = forwardOrEvict(ws, "frame", MARK);
  assert.equal(result, "evicted");
  assert.deepEqual(ws.sent, [], "must not add to an already backed-up socket");
  assert.equal(ws.closed?.code, WS_SLOW_CONSUMER_CODE);
});

test("skips a socket that is not open (no send, no close)", () => {
  const ws = fakeSocket({ readyState: 3 /* CLOSED */, bufferedAmount: 0 });
  const result = forwardOrEvict(ws, "frame", MARK);
  assert.equal(result, "skipped");
  assert.deepEqual(ws.sent, []);
  assert.equal(ws.closed, undefined);
});

test("falls back to terminate() when close() throws", () => {
  const ws = fakeSocket({ bufferedAmount: 20 * 1024 * 1024 });
  ws.close = () => {
    throw new Error("already closing");
  };
  const result = forwardOrEvict(ws, "frame", MARK);
  assert.equal(result, "evicted");
  assert.equal(ws.terminated, true);
});

test("boundary: exactly at the mark still sends (strictly greater evicts)", () => {
  const ws = fakeSocket({ bufferedAmount: MARK });
  const result = forwardOrEvict(ws, "frame", MARK);
  assert.equal(result, "sent");
  assert.deepEqual(ws.sent, ["frame"]);
});
