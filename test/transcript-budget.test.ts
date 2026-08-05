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

// Measure CPU time (user + system), NOT wall-clock. This test asserts an
// algorithmic property (normalization stays ~linear), and on a shared CI runner
// wall-clock is unreliable for that: when the runner is oversubscribed, other
// processes steal the core and inflate wall-clock without the code doing more
// work. process.cpuUsage() counts only time THIS process was on-CPU, so a loaded
// runner can't skew it — the number reflects actual computation, which is what a
// scaling check should be about.
function cpuNormalizeMs(n: number): number {
  const msgs = transcript(n);
  const start = process.cpuUsage();
  const out = normalizeMessages(msgs as never, header);
  const d = process.cpuUsage(start);
  const ms = (d.user + d.system) / 1000; // microseconds → milliseconds
  assert.equal(out.turns.length, n, "every message produces a turn");
  return ms;
}

// The smallest of several runs. Even CPU time carries occasional upward noise (a
// GC sweep landing inside the measured window), never downward, so the MINIMUM
// sample is the cleanest estimate of the true cost and keeps the scaling assertion
// below from flaking.
function bestNormalizeMs(n: number, reps = 6): number {
  let best = Infinity;
  for (let r = 0; r < reps; r++) best = Math.min(best, cpuNormalizeMs(n));
  return best;
}

check("normalizes a 20k-message transcript within budget", () => {
  // Warm up the JIT so the measured run reflects steady state, not first-call cost.
  cpuNormalizeMs(2000);
  cpuNormalizeMs(2000);
  const ms = bestNormalizeMs(20_000);
  // Generous budget (CPU time; normal hardware does this in ~10-15ms).
  assert.ok(ms < 2000, `20k messages normalized in ${ms.toFixed(0)}ms CPU, over the 2000ms budget`);
});

check("cost stays roughly linear (no superlinear blow-up) as size 4x", () => {
  cpuNormalizeMs(2000); // warm up
  // Compare PER-MESSAGE cost at two sizes, each measured as the best of several
  // runs (see bestNormalizeMs). Linear scaling keeps per-message cost ~flat (ratio
  // ~1); an accidental O(n^2) join/scan makes the 4x-larger input's per-message
  // cost grow ~4x. The threshold sits well between the two so the check catches a
  // real quadratic regression without tripping on ordinary CI timing noise.
  const perSmall = bestNormalizeMs(5_000) / 5_000;
  const perBig = bestNormalizeMs(20_000) / 20_000; // 4x the messages
  const growth = perBig / perSmall;
  assert.ok(growth < 3, `per-message cost grew ${growth.toFixed(1)}x from 5k→20k messages — suspect superlinear scaling`);
});

if (failures > 0) { console.error(`\n${failures} transcript-budget test(s) failed`); process.exit(1); }
console.log("\ntranscript-budget: all tests passed");
