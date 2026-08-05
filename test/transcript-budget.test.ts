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

/** Min of several runs ≈ the least-contended run, i.e. true compute cost with
 *  scheduler/GC noise stripped out. Noise on a shared CI runner can only *add*
 *  time, never remove it, so the min is the only robust basis for comparing two
 *  small timings. */
function minTime(n: number, runs = 5): number {
  let m = Infinity;
  for (let i = 0; i < runs; i++) m = Math.min(m, timeNormalize(n));
  return m;
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
  timeNormalize(2000); // warm up the JIT
  // Compare the MIN of several runs at each size, not a single sample. A lone
  // timing of a few-ms operation on a shared CI runner is dominated by GC /
  // scheduler jitter (which only ever adds time), so single-sample ratios
  // flaked as high as ~16x on a genuinely linear algorithm. The min tracks true
  // compute cost; a real O(n^2) regression still shows ~16x here and trips.
  const small = Math.max(minTime(5_000), 0.5);
  const big = minTime(20_000); // 4x the messages
  // Linear would be ~4x; generous slack for noise but still catches quadratic (~16x).
  assert.ok(big / small < 8, `4x the messages took ${(big / small).toFixed(1)}x the time — suspect superlinear scaling`);
});

if (failures > 0) { console.error(`\n${failures} transcript-budget test(s) failed`); process.exit(1); }
console.log("\ntranscript-budget: all tests passed");
