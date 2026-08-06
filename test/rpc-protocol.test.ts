// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { strict as assert } from "node:assert";
import test from "node:test";

import {
  encodeFrame,
  FrameDecoder,
  FRAME_HEADER_BYTES,
  MAX_RPC_FRAME_BYTES,
  RPC_PROTOCOL_VERSION,
  type RpcMessage,
} from "../src/runtime/rpc-protocol.js";

// A representative message of each direction, exercised through the codec.
const startMsg: RpcMessage = {
  t: "start",
  id: 1,
  protocol: RPC_PROTOCOL_VERSION,
  runtime: "claude-code-sdk",
  op: "create",
  options: { workspace: "/tmp/ws", hasToolInterceptor: true },
};
const eventMsg: RpcMessage = {
  t: "event",
  event: { type: "message_update", message: { role: "assistant", content: "hi" } },
  snapshot: { isStreaming: true, activePid: 4242 },
};

test("encode/decode round-trips a single frame", () => {
  const dec = new FrameDecoder();
  const out = dec.push(encodeFrame(startMsg));
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], startMsg);
  assert.equal(dec.pending, 0);
});

test("decodes multiple frames delivered in one chunk", () => {
  const dec = new FrameDecoder();
  const buf = Buffer.concat([encodeFrame(startMsg), encodeFrame(eventMsg)]);
  const out = dec.push(buf);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], startMsg);
  assert.deepEqual(out[1], eventMsg);
});

test("reassembles a frame split across chunk boundaries", () => {
  const dec = new FrameDecoder();
  const frame = encodeFrame(eventMsg);
  // Split at every possible boundary; the decoder must yield exactly once.
  for (let cut = 1; cut < frame.length; cut++) {
    const d = new FrameDecoder();
    const first = d.push(frame.subarray(0, cut));
    assert.equal(first.length, 0, `no message before the frame completes (cut=${cut})`);
    const second = d.push(frame.subarray(cut));
    assert.equal(second.length, 1, `exactly one message once complete (cut=${cut})`);
    assert.deepEqual(second[0], eventMsg);
  }
  // The header itself split byte-by-byte.
  const b0 = dec.push(frame.subarray(0, 2));
  assert.equal(b0.length, 0);
  const b1 = dec.push(frame.subarray(2));
  assert.deepEqual(b1[0], eventMsg);
});

test("preserves order and drains a trailing partial frame", () => {
  const dec = new FrameDecoder();
  const a = encodeFrame({ t: "notify", method: "setName", args: ["Alpha"] });
  const b = encodeFrame({ t: "notify", method: "setName", args: ["Beta"] });
  // One and a half frames: a whole `a`, then the header+part of `b`.
  const out1 = dec.push(Buffer.concat([a, b.subarray(0, 3)]));
  assert.equal(out1.length, 1);
  assert.deepEqual((out1[0] as { args: unknown[] }).args, ["Alpha"]);
  assert.ok(dec.pending > 0, "partial second frame is buffered");
  const out2 = dec.push(b.subarray(3));
  assert.equal(out2.length, 1);
  assert.deepEqual((out2[0] as { args: unknown[] }).args, ["Beta"]);
});

test("carries binary-ish content (unicode, newlines) losslessly", () => {
  const dec = new FrameDecoder();
  const msg: RpcMessage = {
    t: "event",
    event: { type: "message_update", message: { role: "assistant", content: "héllo\n\t— 世界 🌍\r\n{\"x\":1}" } },
  };
  const [decoded] = dec.push(encodeFrame(msg));
  assert.deepEqual(decoded, msg);
});

test("header encodes the exact JSON byte length (big-endian)", () => {
  const frame = encodeFrame({ t: "notify", method: "dispose", args: [] });
  const declared = frame.readUInt32BE(0);
  assert.equal(declared, frame.length - FRAME_HEADER_BYTES);
});

test("rejects a length prefix beyond the cap instead of buffering forever", () => {
  const dec = new FrameDecoder();
  const header = Buffer.allocUnsafe(FRAME_HEADER_BYTES);
  header.writeUInt32BE(MAX_RPC_FRAME_BYTES + 1, 0);
  assert.throws(() => dec.push(header), /RPC frame too large/);
});

test("encode rejects an over-cap payload", () => {
  const huge = "x".repeat(MAX_RPC_FRAME_BYTES + 1);
  assert.throws(
    () => encodeFrame({ t: "event", event: { type: "message_update", blob: huge } }),
    /RPC frame too large/,
  );
});
