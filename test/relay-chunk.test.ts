import assert from "node:assert/strict";
import { frameMessages, FrameReassembler, FRAME_CHUNK_BYTES } from "../src/relay-chunk.js";
import { createFrameReassembler } from "../packages/core/src/relay-frame.js";
import { test as asyncTest } from "node:test";

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

for (const stack of ["node", "browser"] as const) {
  asyncTest(`${stack}: receive failures are explicit, bounded, and released on reset`, async () => {
    const errors: string[] = [];
    const options = { maxBytes: 10, timeoutMs: 15, onReject: (reason: string) => errors.push(reason) };
    const node = stack === "node" ? new FrameReassembler(options) : undefined;
    const browser = stack === "browser" ? createFrameReassembler(options) : undefined;
    const accept = (frame: { fc?: string; fi?: number; fn?: number; p: string }) => node ? node.accept(frame) : browser!(frame);
    accept({ fc: "a", fi: 0, fn: 2, p: "123456" });
    accept({ fc: "b", fi: 0, fn: 2, p: "123456" });
    assert.match(errors.pop()!, /memory/);
    accept({ fc: "b", fi: 1, fn: 2, p: "x" });
    assert.equal(errors.length, 0, "rejected groups cannot be revived by their remaining chunks");
    accept({ fc: "a", fi: 1, fn: 3, p: "x" });
    assert.match(errors.pop()!, /Inconsistent/);
    accept({ p: "x".repeat(11) });
    assert.match(errors.pop()!, /limit/);
    accept({ fc: "timeout", fi: 0, fn: 2, p: "x" });
    await new Promise(resolve => setTimeout(resolve, 35));
    assert.match(errors.pop()!, /timed out/);
    accept({ fc: "complete", fi: 0, fn: 2, p: "a" });
    assert.equal(accept({ fc: "complete", fi: 1, fn: 2, p: "b" }), "ab");
    accept({ fc: "complete", fi: 1, fn: 2, p: "b" });
    accept({ fc: "reset", fi: 0, fn: 2, p: "x" });
    if (node) node.reset(); else browser!.reset();
    await new Promise(resolve => setTimeout(resolve, 35));
    assert.deepEqual(errors, [], "reset and late completed-group duplicates must not leave timeout callbacks");
  });
}
