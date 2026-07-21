import assert from "node:assert/strict";
import { historyDelta } from "../src/history-sync.js";

/**
 * Unit test for incremental history sync: the node should send the whole
 * transcript when the client has nothing or its cached prefix diverged, and only
 * the new tail when the client's prefix matches.
 */

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

const msgs = (n: number) => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: `m${i}` }));

test("no cursor → full send", () => {
  const d = historyDelta(msgs(5));
  assert.equal(d.mode, "full");
  assert.equal(d.baseCount, 0);
  assert.equal(d.count, 5);
  assert.equal(d.messages.length, 5);
  assert.ok(d.historyHash.length > 0);
});

test("matching prefix → append only the tail", () => {
  const all = msgs(10);
  const prefix = historyDelta(all.slice(0, 4)); // what the client cached earlier
  const d = historyDelta(all, { have: 4, haveToken: prefix.historyHash });
  assert.equal(d.mode, "append");
  assert.equal(d.baseCount, 4);
  assert.equal(d.count, 10);
  assert.equal(d.messages.length, 6, "sends only the 6 new messages");
  assert.deepEqual(d.messages, all.slice(4));
});

test("up-to-date client → append with an empty tail (zero new messages)", () => {
  const all = msgs(7);
  const token = historyDelta(all).historyHash;
  const d = historyDelta(all, { have: 7, haveToken: token });
  assert.equal(d.mode, "append");
  assert.equal(d.baseCount, 7);
  assert.equal(d.messages.length, 0, "nothing new to send");
});

test("diverged prefix (wrong token) → full resync", () => {
  const all = msgs(10);
  const d = historyDelta(all, { have: 4, haveToken: "deadbeef" });
  assert.equal(d.mode, "full");
  assert.equal(d.messages.length, 10);
});

test("diverged content at same count → full resync (hash mismatch)", () => {
  const original = msgs(6);
  const token = historyDelta(original.slice(0, 3)).historyHash;
  // The first 3 messages were edited/compacted on the node since the client cached them.
  const edited = [...original];
  edited[1] = { role: "assistant", text: "EDITED" };
  const d = historyDelta(edited, { have: 3, haveToken: token });
  assert.equal(d.mode, "full", "a changed prefix must not be appended onto");
});

test("have beyond current length → full resync", () => {
  const all = msgs(3);
  const token = historyDelta(all).historyHash;
  const d = historyDelta(all, { have: 9, haveToken: token });
  assert.equal(d.mode, "full");
});

test("historyHash is stable for identical content", () => {
  assert.equal(historyDelta(msgs(8)).historyHash, historyDelta(msgs(8)).historyHash);
});

test("have <= 0 is ignored → full send", () => {
  const all = msgs(4);
  const d = historyDelta(all, { have: 0, haveToken: historyDelta([]).historyHash });
  assert.equal(d.mode, "full");
});

console.log(`\nAll ${passed} history-sync checks passed.`);
