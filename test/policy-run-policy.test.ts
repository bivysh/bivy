import assert from "node:assert/strict";
import { createRunPolicy, computeBackoffMs, type RunDecision } from "../src/policy/run-policy.js";
import { DEFAULT_RULESET, findRule, validateRuleset, type Ruleset } from "../src/policy/ruleset.js";

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

// Deterministic jitter: random()=0.5 → spread term is 0 → delay == raw target.
const noJitter = () => 0.5;
const decideWith = (ruleset: Ruleset, hasCredential?: (c: { account?: string }) => boolean) =>
  createRunPolicy({ ruleset, context: "queue", random: noJitter, hasCredential });

// ── Schema validation ───────────────────────────────────────────────────────

check("the default ruleset is valid", () => {
  const v = validateRuleset(DEFAULT_RULESET);
  assert.equal(v.ok, true);
  assert.ok(v.ruleset);
});

check("validation rejects a malformed ruleset with readable errors", () => {
  const v = validateRuleset({ version: 2, name: "", rules: "nope" });
  assert.equal(v.ok, false);
  assert.ok(v.errors.length > 0);
});

check("validation rejects an unknown condition in a rule", () => {
  const v = validateRuleset({
    version: 1,
    name: "x",
    appliesTo: ["queue"],
    rules: [{ when: ["made_up"], action: "retry", maxAttempts: 2 }],
  });
  assert.equal(v.ok, false);
});

// ── Pure matcher ────────────────────────────────────────────────────────────

check("findRule matches by condition and context", () => {
  assert.ok(findRule(DEFAULT_RULESET, "rate_limited", "queue"));
  assert.equal(findRule(DEFAULT_RULESET, "task_failed", "queue"), undefined);
});

check("a rule is inert in a context it doesn't apply to", () => {
  const ruleset: Ruleset = {
    version: 1,
    name: "queue-only",
    appliesTo: ["queue"],
    rules: [{ when: ["rate_limited"], action: "retry", maxAttempts: 2 }],
  };
  assert.ok(findRule(ruleset, "rate_limited", "queue"));
  assert.equal(findRule(ruleset, "rate_limited", "session"), undefined);
});

// ── Decisions on the default ruleset ────────────────────────────────────────

const def = decideWith(DEFAULT_RULESET);

check("transient error retries with computed backoff", () => {
  const d = def.decide({ routing: {}, error: "socket hang up", attempt: 1, rerouteCount: 0 });
  assert.equal(d.action, "retry");
  if (d.action === "retry") assert.equal(d.delayMs, 2000); // base·factor^0
});

check("retry exhaustion parks (default onExhausted)", () => {
  // transport_error maxAttempts is 3 → the 3rd failure has no retry left.
  const d = def.decide({ routing: {}, error: "socket hang up", attempt: 3, rerouteCount: 0 });
  assert.equal(d.action, "park");
});

check("a provider-supplied wait overrides computed backoff", () => {
  const d = def.decide({ routing: {}, error: "429; retry-after: 45", attempt: 1, rerouteCount: 0 });
  assert.equal(d.action, "retry");
  if (d.action === "retry") assert.equal(d.delayMs, 45_000);
});

check("a retry rule waits until a session limit resets", () => {
  const ruleset: Ruleset = {
    version: 1,
    name: "resume-session-limit",
    appliesTo: ["queue"],
    rules: [{ when: ["credits_exhausted"], action: "retry", maxAttempts: 2 }],
  };
  const now = Date.parse("2026-07-27T18:00:00Z");
  const policy = createRunPolicy({ ruleset, context: "queue", random: noJitter, now: () => now });
  const d = policy.decide({
    routing: {},
    error: "You've hit your limit; resets_at 2026-07-27T20:30:00Z",
    attempt: 1,
    rerouteCount: 0,
  });
  assert.equal(d.action, "retry");
  if (d.action === "retry") {
    assert.equal(d.delayMs, 9_000_000);
    assert.match(d.summary, /when the limit resets at 2026-07-27T20:30:00Z/);
  }
});

check("a reset time in the past retries immediately instead of using backoff", () => {
  const ruleset: Ruleset = {
    version: 1,
    name: "past-reset",
    appliesTo: ["queue"],
    rules: [{ when: ["credits_exhausted"], action: "retry", maxAttempts: 2 }],
  };
  const policy = createRunPolicy({
    ruleset,
    context: "queue",
    random: noJitter,
    now: () => Date.parse("2026-07-27T21:00:00Z"),
  });
  const d = policy.decide({
    routing: {},
    error: "session limit reached; resets_at 2026-07-27T20:30:00Z",
    attempt: 1,
    rerouteCount: 0,
  });
  assert.equal(d.action, "retry");
  if (d.action === "retry") assert.equal(d.delayMs, 0);
});

check("a weekly limit's wall-clock reset is honored, and exposed on the decision", () => {
  const ruleset: Ruleset = {
    version: 1,
    name: "resume-weekly",
    appliesTo: ["session"],
    rules: [{ when: ["credits_exhausted"], action: "retry", maxAttempts: 3 }],
  };
  const now = Date.parse("2026-08-05T22:40:00Z");
  const policy = createRunPolicy({ ruleset, context: "session", random: noJitter, now: () => now });
  const d = policy.decide({
    routing: {},
    error: "You've hit your weekly limit · resets 12am (UTC)",
    attempt: 1,
    rerouteCount: 0,
  });
  assert.equal(d.action, "retry");
  if (d.action === "retry") {
    // next midnight UTC (00:00 on the 6th) is 1h20m out
    assert.equal(d.resetsAt, "2026-08-06T00:00:00.000Z");
    assert.equal(d.delayMs, 80 * 60 * 1000);
  }
});

check("a structured resetsAtHint overrides the ambiguous text reset time", () => {
  const ruleset: Ruleset = {
    version: 1,
    name: "resume-weekly-hint",
    appliesTo: ["session"],
    rules: [{ when: ["credits_exhausted"], action: "retry", maxAttempts: 3 }],
  };
  const now = Date.parse("2026-08-05T22:40:00Z");
  const policy = createRunPolicy({ ruleset, context: "session", random: noJitter, now: () => now });
  const d = policy.decide({
    routing: {},
    error: "You've hit your weekly limit · resets 12am (UTC)",
    attempt: 1,
    rerouteCount: 0,
    resetsAtHint: "2026-08-11T00:00:00.000Z", // the real 7-day reset, days out
  });
  assert.equal(d.action, "retry");
  if (d.action === "retry") {
    assert.equal(d.resetsAt, "2026-08-11T00:00:00.000Z");
    assert.equal(d.delayMs, Date.parse("2026-08-11T00:00:00.000Z") - now);
  }
});

check("quota/auth/context park immediately", () => {
  for (const err of ["credit balance is too low", "401 Unauthorized", "maximum context length exceeded, tokens"]) {
    const d = def.decide({ routing: {}, error: err, attempt: 1, rerouteCount: 0 });
    assert.equal(d.action, "park", `expected park for "${err}", got ${d.action}`);
  }
});

check("an unclassified failure gives up (preserves historical fail behavior)", () => {
  const d = def.decide({ routing: {}, error: "kaboom", attempt: 1, rerouteCount: 0 });
  assert.equal(d.action, "give_up");
});

// ── Reroute + fallback chain ────────────────────────────────────────────────

const rerouteRuleset: Ruleset = {
  version: 1,
  name: "reroute",
  appliesTo: ["queue"],
  rules: [
    {
      when: ["credits_exhausted"],
      action: "reroute",
      maxAttempts: 5,
      chain: [{ account: "primary" }, { model: "sonnet", account: "secondary" }, { runtimeId: "codex", model: "gpt-5" }],
      onExhausted: "park",
      backoff: { baseMs: 1000, factor: 2, capMs: 10_000, jitter: 0 },
    },
  ],
};

check("reroute picks the first chain candidate", () => {
  const d = decideWith(rerouteRuleset).decide({
    routing: {},
    error: "quota exceeded",
    attempt: 1,
    rerouteCount: 0,
  });
  assert.equal(d.action, "reroute");
  if (d.action === "reroute") {
    assert.equal(d.routing.account, "primary");
    assert.equal(d.rerouteCount, 1);
  }
});

check("reroute skips candidates that provably lack credentials", () => {
  // primary has no creds → the resolver advances to the second candidate.
  const policy = decideWith(rerouteRuleset, (c) => c.account !== "primary");
  const d = policy.decide({ routing: {}, error: "quota exceeded", attempt: 1, rerouteCount: 0 });
  assert.equal(d.action, "reroute");
  if (d.action === "reroute") {
    assert.equal(d.routing.model, "sonnet");
    assert.equal(d.routing.account, "secondary");
    assert.equal(d.rerouteCount, 2); // cursor advanced past the skipped candidate
  }
});

check("reroute advances through the chain via the cursor", () => {
  const d = decideWith(rerouteRuleset).decide({
    routing: { account: "secondary" },
    error: "quota exceeded",
    attempt: 2,
    rerouteCount: 2,
  });
  assert.equal(d.action, "reroute");
  if (d.action === "reroute") {
    assert.equal(d.routing.runtimeId, "codex");
    assert.equal(d.routing.model, "gpt-5");
  }
});

check("a drained chain parks via onExhausted", () => {
  const d = decideWith(rerouteRuleset).decide({
    routing: {},
    error: "quota exceeded",
    attempt: 4,
    rerouteCount: 3, // past the end of a 3-candidate chain
  });
  assert.equal(d.action, "park");
});

// ── Backoff math ────────────────────────────────────────────────────────────

check("backoff grows geometrically and honors the cap", () => {
  const cfg = { baseMs: 1000, factor: 2, capMs: 5000, jitter: 0 };
  assert.equal(computeBackoffMs(cfg, 0, noJitter), 1000);
  assert.equal(computeBackoffMs(cfg, 1, noJitter), 2000);
  assert.equal(computeBackoffMs(cfg, 2, noJitter), 4000);
  assert.equal(computeBackoffMs(cfg, 3, noJitter), 5000); // capped (would be 8000)
});

check("jitter stays within ±jitter/2 of the target", () => {
  const cfg = { baseMs: 1000, factor: 1, capMs: 10_000, jitter: 0.3 };
  for (const r of [0, 0.25, 0.5, 0.75, 1]) {
    const ms = computeBackoffMs(cfg, 0, () => r);
    assert.ok(ms >= 850 && ms <= 1150, `delay ${ms} outside 850–1150 for random=${r}`);
  }
});

// ── No policy → historical behavior ─────────────────────────────────────────

check("with no ruleset match the caller keeps its existing failure path", () => {
  const d: RunDecision = createRunPolicy({ context: "queue" }).decide({
    routing: {},
    error: "some task assertion failed unexpectedly xyz",
    attempt: 1,
    rerouteCount: 0,
  });
  assert.equal(d.action, "give_up");
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log("\npolicy-run-policy: all tests passed");
