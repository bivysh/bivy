import assert from "node:assert/strict";
import {
  configuredTurnTimeoutMs,
  DEFAULT_TURN_TIMEOUT_MS,
  MAX_TURN_TIMEOUT_MS,
  configuredTurnStallMs,
  DEFAULT_TURN_STALL_MS,
  MIN_TURN_STALL_MS,
  PID_DEAD_GRACE_MS,
  isTurnStalled,
  classifyStallTrigger,
} from "../src/session/turn-watchdog.js";

assert.equal(configuredTurnTimeoutMs(undefined), DEFAULT_TURN_TIMEOUT_MS, "missing config uses a finite default");
assert.equal(configuredTurnTimeoutMs(""), DEFAULT_TURN_TIMEOUT_MS, "blank config uses the finite default");
assert.equal(configuredTurnTimeoutMs("0"), 0, "explicit zero is the documented trusted-workflow escape hatch");
assert.equal(configuredTurnTimeoutMs("250"), 1_000, "tiny values clamp to one second");
assert.equal(configuredTurnTimeoutMs("90000"), 90_000, "ordinary values pass through");
assert.equal(configuredTurnTimeoutMs("not-a-number"), DEFAULT_TURN_TIMEOUT_MS, "malformed config fails safe");
assert.equal(configuredTurnTimeoutMs("-1"), DEFAULT_TURN_TIMEOUT_MS, "negative config fails safe");
assert.equal(configuredTurnTimeoutMs(String(MAX_TURN_TIMEOUT_MS * 2)), MAX_TURN_TIMEOUT_MS, "the failure window is capped");

// ---- stall config -----------------------------------------------------------
assert.equal(configuredTurnStallMs(undefined), DEFAULT_TURN_STALL_MS, "missing stall config uses the default");
assert.equal(configuredTurnStallMs(""), DEFAULT_TURN_STALL_MS, "blank stall config uses the default");
assert.equal(configuredTurnStallMs("0"), 0, "explicit zero opts out of stall detection");
assert.equal(configuredTurnStallMs("1000"), MIN_TURN_STALL_MS, "tiny stall values clamp to the floor");
assert.equal(configuredTurnStallMs("120000"), 120_000, "ordinary stall values pass through");
assert.equal(configuredTurnStallMs("nope"), DEFAULT_TURN_STALL_MS, "malformed stall config fails safe");
assert.equal(configuredTurnStallMs("-5"), DEFAULT_TURN_STALL_MS, "negative stall config fails safe");

// ---- stall decision ---------------------------------------------------------
const stallMs = 5 * 60_000;
assert.equal(
  isTurnStalled({ now: 1_000_000, lastProgressAt: 1_000_000 - 60_000, stallMs }),
  false,
  "a turn that emitted progress 1 min ago is not stalled",
);
assert.equal(
  isTurnStalled({ now: 1_000_000, lastProgressAt: 1_000_000 - stallMs, stallMs }),
  true,
  "no progress for the whole stall window is stalled",
);
assert.equal(
  isTurnStalled({ now: 1_000_000, lastProgressAt: 1_000_000 - 60_000, stallMs, pidAlive: true }),
  false,
  "a live subprocess with recent progress is not stalled",
);
assert.equal(
  isTurnStalled({ now: 1_000_000, lastProgressAt: 1_000_000 - PID_DEAD_GRACE_MS, stallMs, pidAlive: false }),
  true,
  "a dead subprocess past the grace is stuck even well before the idle window",
);
assert.equal(
  isTurnStalled({ now: 1_000_000, lastProgressAt: 1_000_000 - 1_000, stallMs, pidAlive: false }),
  false,
  "a just-exited subprocess inside the grace settles itself first (no premature recovery)",
);
assert.equal(
  isTurnStalled({ now: 1_000_000, lastProgressAt: 0, stallMs: 0 }),
  false,
  "stallMs<=0 disables the idle check",
);
assert.equal(
  isTurnStalled({ now: 1_000_000, lastProgressAt: 1_000_000 - PID_DEAD_GRACE_MS, stallMs: 0, pidAlive: false }),
  true,
  "a dead subprocess is still recovered even with idle detection disabled",
);

// ---- stall trigger classification (diagnostics) -----------------------------
// classifyStallTrigger is the finer sibling of isTurnStalled: same decision, but
// it names WHY so the daemon can attribute recoveries per runtime.
assert.equal(
  classifyStallTrigger({ now: 1_000_000, lastProgressAt: 1_000_000 - 60_000, stallMs }),
  null,
  "recent progress → not stalled → no trigger",
);
assert.equal(
  classifyStallTrigger({ now: 1_000_000, lastProgressAt: 1_000_000 - stallMs, stallMs }),
  "stalled",
  "silence past the idle window is classified as a stall",
);
assert.equal(
  classifyStallTrigger({ now: 1_000_000, lastProgressAt: 1_000_000 - PID_DEAD_GRACE_MS, stallMs, pidAlive: false }),
  "pid_dead",
  "a dead subprocess past the grace is classified pid_dead, not stalled",
);
assert.equal(
  classifyStallTrigger({ now: 1_000_000, lastProgressAt: 1_000_000 - 1_000, stallMs, pidAlive: false }),
  null,
  "a just-exited subprocess inside the grace has no trigger yet",
);
assert.equal(
  classifyStallTrigger({ now: 1_000_000, lastProgressAt: 1_000_000 - stallMs, stallMs: 0 }),
  null,
  "stallMs<=0 disables the idle trigger",
);
// pid_dead wins over the idle timer even when idle detection is off.
assert.equal(
  classifyStallTrigger({ now: 1_000_000, lastProgressAt: 1_000_000 - PID_DEAD_GRACE_MS, stallMs: 0, pidAlive: false }),
  "pid_dead",
  "a dead subprocess is reported even with idle detection disabled",
);
// isTurnStalled stays a boolean view of the same decision.
assert.equal(
  isTurnStalled({ now: 1_000_000, lastProgressAt: 1_000_000 - stallMs, stallMs }),
  classifyStallTrigger({ now: 1_000_000, lastProgressAt: 1_000_000 - stallMs, stallMs }) !== null,
  "isTurnStalled agrees with classifyStallTrigger",
);

console.log("turn-watchdog: all tests passed");
