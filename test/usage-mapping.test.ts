import assert from "node:assert/strict";
import { mapUsageResponse, sumModelUsage } from "../src/runtime/claude-code.js";

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

check("sumModelUsage totals across multiple models", () => {
  const totals = sumModelUsage({
    "claude-opus-4-8": { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 10, cacheCreationInputTokens: 5 },
    "claude-sonnet-5": { inputTokens: 200, outputTokens: 75 },
  });
  assert.deepEqual(totals, { input: 300, output: 125, cacheRead: 10, cacheWrite: 5, total: 440 });
});

check("mapUsageResponse: API-key session has no plan rate limits", () => {
  const snapshot = mapUsageResponse({
    session: { total_cost_usd: 1.23, model_usage: { "claude-opus-4-8": { inputTokens: 10, outputTokens: 5 } } },
    subscription_type: null,
    rate_limits_available: false,
    rate_limits: null,
  });
  assert.equal(snapshot.costUsd, 1.23);
  assert.equal(snapshot.tokens?.total, 15);
  assert.equal(snapshot.plan?.subscriptionType, null);
  assert.deepEqual(snapshot.plan?.windows, []);
});

check("mapUsageResponse: Claude Max OAuth session surfaces rate-limit windows", () => {
  const snapshot = mapUsageResponse({
    session: { total_cost_usd: 0, model_usage: {} },
    subscription_type: "max",
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 42, resets_at: "2026-07-04T20:00:00Z" },
      seven_day: { utilization: 10, resets_at: "2026-07-11T00:00:00Z" },
      seven_day_opus: null,
      model_scoped: [{ display_name: "Fable", utilization: 5, resets_at: "2026-07-11T00:00:00Z" }],
    },
  });
  assert.equal(snapshot.plan?.subscriptionType, "max");
  const labels = snapshot.plan?.windows.map((w) => w.label);
  assert.deepEqual(labels, ["5-hour", "7-day", "Fable"]);
  assert.equal(snapshot.plan?.windows.find((w) => w.label === "5-hour")?.utilizationPct, 42);
});

check("mapUsageResponse never throws on a malformed/empty response", () => {
  assert.doesNotThrow(() => mapUsageResponse(undefined));
  assert.doesNotThrow(() => mapUsageResponse({}));
  const snapshot = mapUsageResponse({});
  assert.equal(snapshot.costUsd, undefined);
  assert.equal(snapshot.tokens, undefined);
  assert.deepEqual(snapshot.plan?.windows, []);
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log("\nusage-mapping: all tests passed");
