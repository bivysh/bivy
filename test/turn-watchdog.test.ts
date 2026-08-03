import assert from "node:assert/strict";
import { configuredTurnTimeoutMs, DEFAULT_TURN_TIMEOUT_MS, MAX_TURN_TIMEOUT_MS } from "../src/session/turn-watchdog.js";

assert.equal(configuredTurnTimeoutMs(undefined), DEFAULT_TURN_TIMEOUT_MS, "missing config uses a finite default");
assert.equal(configuredTurnTimeoutMs(""), DEFAULT_TURN_TIMEOUT_MS, "blank config uses the finite default");
assert.equal(configuredTurnTimeoutMs("0"), 0, "explicit zero is the documented trusted-workflow escape hatch");
assert.equal(configuredTurnTimeoutMs("250"), 1_000, "tiny values clamp to one second");
assert.equal(configuredTurnTimeoutMs("90000"), 90_000, "ordinary values pass through");
assert.equal(configuredTurnTimeoutMs("not-a-number"), DEFAULT_TURN_TIMEOUT_MS, "malformed config fails safe");
assert.equal(configuredTurnTimeoutMs("-1"), DEFAULT_TURN_TIMEOUT_MS, "negative config fails safe");
assert.equal(configuredTurnTimeoutMs(String(MAX_TURN_TIMEOUT_MS * 2)), MAX_TURN_TIMEOUT_MS, "the failure window is capped");

console.log("turn-watchdog: all tests passed");
