import assert from "node:assert/strict";
import { normalizeMessages } from "../src/session/transcript-normal.js";

// Long-transcript budget (B4b). The transcript pipeline must stay roughly linear
// in message count — a superlinear regression (an accidental O(n^2) join/scan)
// would make long sessions hang. This bounds normalization of a large synthetic
// transcript and checks the per-message cost doesn't blow up as it grows.

let failures = 0;
function check(name: string, fn: () => void) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (error) { failures++; console.error(`FAIL  ${name}\n      ${(error as Error).message}`); }
}

const header = { sourceRuntimeId: "pi", createdAt: "2026-08-04T00:00:00Z" };

function transcript(n: number) {
  const msgs: Array<{ role: string; content: string }> = [];
  for (let i = 0; i < n; i++) {
    msgs.push({ role: i % 2 ? "assistant" : "user", content: `message ${i} with some words to normalize and scan` });
  }
  return msgs;
}

function timeNormalize(n: number): number {
  const msgs = transcript(n);
  const start = process.hrtime.bigint();
  const out = normalizeMessages(msgs as never, header);
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.equal(out.turns.length, n, "every message produces a turn");
  return ms;
}

check("normalizes a 20k-message transcript within budget", () => {
  // Warm up the JIT so the measured run reflects steady state, not first-call cost.
  // Run the warm-up twice; some CI runners are noisy on first JIT.
  timeNormalize(2000);
  timeNormalize(2000);
  const ms = timeNormalize(20_000);
  // Generous budget for CI runners under load (normal hardware does this in ~10-15ms).
  assert.ok(ms < 2000, `20k messages normalized in ${ms.toFixed(0)}ms, over the 2000ms budget`);
});

check("cost stays roughly linear (no superlinear blow-up) as size 4x", () => {
  timeNormalize(2000); // warm up
  const small = Math.max(timeNormalize(5_000), 1);
  const big = timeNormalize(20_000); // 4x the messages
  // Linear would be ~4x; allow generous slack for noise but catch quadratic (~16x).
  assert.ok(big / small < 8, `4x the messages took ${(big / small).toFixed(1)}x the time — suspect superlinear scaling`);
});

if (failures > 0) { console.error(`\n${failures} transcript-budget test(s) failed`); process.exit(1); }
console.log("\ntranscript-budget: all tests passed");
