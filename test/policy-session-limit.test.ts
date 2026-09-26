import assert from "node:assert/strict";
import { detectSessionLimit, limitResumePlan, sessionLimitNotice } from "../src/policy/session-limit.js";

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${(error as Error).message}`);
  }
}

const NOW = Date.parse("2026-09-26T08:25:00Z");

check("a usage limit with a stated reset offers fork + retry-at-reset", () => {
  const limit = detectSessionLimit("You've hit your usage limit · resets 12pm (UTC)", { now: NOW });
  assert.deepEqual(limit, { condition: "credits_exhausted", resetsAt: "2026-09-26T12:00:00.000Z" });
  assert.deepEqual(sessionLimitNotice("Claude Code", limit!).actions, ["fork", "retry-at-reset:2026-09-26T12:00:00.000Z"]);
});

check("the structured reset hint wins over the text (weekly window)", () => {
  const limit = detectSessionLimit("you've hit your weekly limit · resets 12am (UTC)", { now: NOW, resetsAtHint: "2026-09-29T00:00:00Z" });
  assert.equal(limit?.resetsAt, "2026-09-29T00:00:00Z");
});

check("a limit with no known reset offers only fork, and no resume plan", () => {
  const limit = detectSessionLimit("Your credit balance is too low", { now: NOW })!;
  assert.deepEqual(sessionLimitNotice("Pi", limit).actions, ["fork"]);
  assert.equal(limitResumePlan(limit, NOW), undefined);
});

check("a non-limit failure is not a limit", () => {
  assert.equal(detectSessionLimit("tests failed: 3 assertions", { now: NOW }), undefined);
});

check("resume plan lands just after the reset, and shortly from now if it already passed", () => {
  const future = limitResumePlan({ condition: "credits_exhausted", resetsAt: "2026-09-26T12:00:00Z" }, NOW)!;
  assert.equal(future.resumeAt, "2026-09-26T12:01:00.000Z");
  const past = limitResumePlan({ condition: "rate_limited", resetsAt: "2026-09-26T08:00:00Z" }, NOW)!;
  assert.equal(past.delayMs, 60_000);
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log("\npolicy-session-limit: all tests passed");
