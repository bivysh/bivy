import assert from "node:assert/strict";
import { classifyFailure, parseRetryAfterMs, parseResetsAt } from "../src/policy/conditions.js";

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

const cases: [string, string][] = [
  ["HTTP 429 Too Many Requests", "rate_limited"],
  ["Error: overloaded_error, please retry", "rate_limited"],
  ["Your credit balance is too low to run this request", "credits_exhausted"],
  ["402 Payment Required: quota exceeded for this month", "credits_exhausted"],
  ["This model's maximum context length is 200000 tokens", "context_overflow"],
  ["prompt is too long: 250000 tokens", "context_overflow"],
  ["unexpected status 401 Unauthorized", "auth_failed"],
  ["invalid x-api-key", "auth_failed"],
  ["connect ECONNREFUSED 10.0.0.4:22", "node_offline"],
  ["socket hang up", "transport_error"],
  ["request timed out after 30s", "transport_error"],
  ["fetch failed: EAI_AGAIN", "transport_error"],
  ["3 tests failed, aborting", "task_failed"],
  ["the agent made no changes to the workspace", "task_failed"],
  ["totally unrecognized explosion", "unknown"],
];

for (const [raw, expected] of cases) {
  check(`classifies "${raw.slice(0, 32)}…" → ${expected}`, () => {
    assert.equal(classifyFailure(raw).condition, expected);
  });
}

check("classifies a thrown Error, not just a string", () => {
  assert.equal(classifyFailure(new Error("HTTP 429 slow down")).condition, "rate_limited");
});

check("more-specific conditions win over broad ones (billing before rate-limit)", () => {
  // Contains both a 429 and an explicit quota message — quota is the actionable one.
  assert.equal(classifyFailure("429: monthly quota exceeded, billing required").condition, "credits_exhausted");
});

check("auth 401 wins even when other noise is present", () => {
  assert.equal(classifyFailure("401 Unauthorized (after a network timeout)").condition, "auth_failed");
});

check("parses retry-after header seconds", () => {
  assert.equal(parseRetryAfterMs("rate limited, retry-after: 12"), 12_000);
});

check("parses a natural-language wait", () => {
  assert.equal(parseRetryAfterMs("please try again in 2 minutes"), 120_000);
});

check("attaches retryAfterMs to a rate-limit classification", () => {
  const c = classifyFailure("429 Too Many Requests; retry-after: 30");
  assert.equal(c.condition, "rate_limited");
  assert.equal(c.retryAfterMs, 30_000);
});

check("parses an ISO reset timestamp", () => {
  assert.equal(parseResetsAt("quota resets_at 2026-07-27T18:00:00Z"), "2026-07-27T18:00:00Z");
});

check("does not invent recovery hints for unknown failures", () => {
  const c = classifyFailure("kaboom");
  assert.equal(c.retryAfterMs, undefined);
  assert.equal(c.resetsAt, undefined);
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log("\npolicy-conditions: all tests passed");
