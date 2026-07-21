import assert from "node:assert/strict";
import { sealFrame, openFrame } from "../src/e2e.js";
import { frameMessages, FrameReassembler, FRAME_CHUNK_BYTES } from "../src/relay-chunk.js";

/**
 * Unit test for relay frame chunking: large sealed payloads must split into
 * multiple wire frames (each below the relay's max-frame cap) and reassemble
 * back into the exact original, while small frames stay single and unchanged.
 */

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

const RELAY_MAX_FRAME_BYTES = 256 * 1024; // relay default

test("small payload is a single, unchunked frame", () => {
  const msgs = frameMessages("hello");
  assert.equal(msgs.length, 1);
  const env = JSON.parse(msgs[0]);
  assert.equal(env.t, "frame");
  assert.equal(env.p, "hello");
  assert.equal(env.fc, undefined, "small frames carry no chunk metadata");
});

test("a non-chunked frame passes straight through the reassembler", () => {
  const r = new FrameReassembler();
  assert.equal(r.accept({ p: "hello" }), "hello");
});

test("large payload splits into multiple frames, each under the relay cap", () => {
  const big = "x".repeat(FRAME_CHUNK_BYTES * 3 + 1234);
  const msgs = frameMessages(big);
  assert.ok(msgs.length >= 4, `expected several chunks, got ${msgs.length}`);
  for (const m of msgs) {
    assert.ok(Buffer.byteLength(m) < RELAY_MAX_FRAME_BYTES, "each wire frame must fit under the relay cap");
    const env = JSON.parse(m);
    assert.equal(env.t, "frame");
    assert.equal(typeof env.fc, "string");
    assert.equal(env.fn, msgs.length);
  }
});

test("chunks reassemble back to the exact original payload", () => {
  const big = "abcdefghij".repeat(FRAME_CHUNK_BYTES); // ~1.9 MB
  const msgs = frameMessages(big);
  const r = new FrameReassembler();
  let result: string | null = null;
  msgs.forEach((m, idx) => {
    const out = r.accept(JSON.parse(m));
    if (idx < msgs.length - 1) assert.equal(out, null, "incomplete groups yield null");
    else result = out;
  });
  assert.equal(result, big, "reassembled payload must match the original");
});

test("out-of-order chunks still reassemble correctly", () => {
  const big = "z".repeat(FRAME_CHUNK_BYTES * 2 + 5);
  const msgs = frameMessages(big).map((m) => JSON.parse(m));
  const r = new FrameReassembler();
  // Feed in reverse order.
  let result: string | null = null;
  for (const env of [...msgs].reverse()) {
    const out = r.accept(env);
    if (out !== null) result = out;
  }
  assert.equal(result, big);
});

test("end-to-end: seal a large event, chunk it, reassemble, and decrypt", () => {
  const key = Buffer.alloc(32, 7);
  const event = { type: "tool_result", text: "L".repeat(FRAME_CHUNK_BYTES * 2) };
  const payload = sealFrame(key, event);
  const msgs = frameMessages(payload);
  assert.ok(msgs.length > 1, "this payload should chunk");
  const r = new FrameReassembler();
  let full: string | null = null;
  for (const m of msgs) {
    const out = r.accept(JSON.parse(m));
    if (out !== null) full = out;
  }
  assert.ok(full, "reassembly should complete");
  const frame = openFrame(key, full!);
  assert.deepEqual(frame.data, event, "decrypted event must equal the original");
});

test("duplicate chunk index is ignored (not double-counted)", () => {
  const big = "q".repeat(FRAME_CHUNK_BYTES * 2 + 1);
  const msgs = frameMessages(big).map((m) => JSON.parse(m));
  const r = new FrameReassembler();
  assert.equal(r.accept(msgs[0]), null);
  assert.equal(r.accept(msgs[0]), null, "re-sending the same chunk must not complete the group");
  let result: string | null = null;
  for (let i = 1; i < msgs.length; i++) {
    const out = r.accept(msgs[i]);
    if (out !== null) result = out;
  }
  assert.equal(result, big);
});

console.log(`\nAll ${passed} relay-chunk checks passed.`);
