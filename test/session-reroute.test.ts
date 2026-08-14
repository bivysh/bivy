import assert from "node:assert/strict";
import { SessionRerouteController, type SessionRerouteTarget } from "../src/policy/session-reroute.js";
import { createRunPolicy } from "../src/policy/run-policy.js";
import type { Ruleset } from "../src/policy/ruleset.js";

let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${(error as Error).message}`);
  }
}

// A session ruleset like the one BIVY_SESSION_MODEL_FALLBACK builds.
const ruleset: Ruleset = {
  version: 1,
  name: "session-model-fallback",
  appliesTo: ["session"],
  rules: [
    {
      when: ["credits_exhausted", "rate_limited"],
      action: "reroute",
      maxAttempts: 3,
      chain: [{ model: "claude-sonnet" }, { model: "claude-haiku" }],
      onExhausted: "give_up",
      backoff: { baseMs: 0, factor: 1, capMs: 0, jitter: 0 },
    },
  ],
};

function makeController(overrides: Partial<Parameters<typeof SessionRerouteController.prototype.constructor>[0]> = {}) {
  const events: string[] = [];
  const notices: string[] = [];
  const failedMsgs: string[] = [];
  const controller = new SessionRerouteController({
    policy: createRunPolicy({ ruleset, context: "session", random: () => 0.5 }),
    sleep: async () => {},
    onEvent: (e) => events.push(e.summary),
    onNotice: (n) => notices.push(n.message),
    onModelChanged: () => events.push("model-changed"),
    onFailed: (m) => failedMsgs.push(m),
    ...overrides,
  });
  return { controller, events, notices, failedMsgs };
}

/** A fake live session that records model swaps and reprompts, and can be told
 *  which model value causes the *next* turn to fail. */
function makeTarget(startModel: string) {
  const state = { model: startModel as string | undefined, reprompts: 0, swaps: [] as string[] };
  const target: SessionRerouteTarget = {
    getCurrentModelName: () => state.model,
    setModel: async (_provider, id) => {
      state.model = id;
      state.swaps.push(id);
    },
    reprompt: async () => {
      state.reprompts += 1;
    },
  };
  return { target, state };
}

await check("reroutes to the first fallback model and retries the prompt", async () => {
  const { controller, notices, events } = makeController();
  const { target, state } = makeTarget("claude-opus");
  controller.beginTurn();

  const plan = controller.planReroute("credit balance is too low", state.model);
  assert.ok(plan, "should plan a reroute");
  assert.equal(plan!.model, "claude-sonnet");
  await controller.applyReroute(plan!, target);

  assert.deepEqual(state.swaps, ["claude-sonnet"], "swapped to first fallback");
  assert.equal(state.reprompts, 1, "re-drove the prompt once");
  assert.equal(state.model, "claude-sonnet");
  assert.ok(notices.some((n) => n.includes("claude-sonnet")), "notified the user");
  assert.ok(events.includes("model-changed"));
});

await check("walks the chain across successive failures, then gives up", async () => {
  const { controller } = makeController();
  const { target, state } = makeTarget("claude-opus");
  controller.beginTurn();

  // Failure 1 → sonnet
  const p1 = controller.planReroute("quota exceeded", state.model);
  assert.equal(p1?.model, "claude-sonnet");
  await controller.applyReroute(p1!, target);

  // Failure 2 → haiku
  const p2 = controller.planReroute("quota exceeded", state.model);
  assert.equal(p2?.model, "claude-haiku");
  await controller.applyReroute(p2!, target);

  // Failure 3 → chain drained → no plan (error surfaces)
  const p3 = controller.planReroute("quota exceeded", state.model);
  assert.equal(p3, null, "chain exhausted → give up");
  assert.deepEqual(state.swaps, ["claude-sonnet", "claude-haiku"]);
});

await check("does not reroute conditions the ruleset doesn't cover", async () => {
  const { controller } = makeController();
  controller.beginTurn();
  assert.equal(controller.planReroute("401 Unauthorized", "claude-opus"), null);
  assert.equal(controller.planReroute("tests failed", "claude-opus"), null);
});

await check("skips a candidate equal to the current model", async () => {
  const { controller } = makeController();
  controller.beginTurn();
  // Already on the first fallback → planning should pick the next one, not re-pick it.
  const plan = controller.planReroute("quota exceeded", "claude-sonnet");
  assert.ok(plan);
  assert.notEqual(plan!.model, "claude-sonnet");
});

await check("beginTurn resets the reroute budget for a new user turn", async () => {
  const { controller } = makeController();
  const { target, state } = makeTarget("claude-opus");
  controller.beginTurn();
  await controller.applyReroute(controller.planReroute("quota exceeded", state.model)!, target);
  await controller.applyReroute(controller.planReroute("quota exceeded", state.model)!, target);
  assert.equal(controller.planReroute("quota exceeded", state.model), null, "exhausted within the turn");

  controller.beginTurn(); // new user turn
  const plan = controller.planReroute("quota exceeded", "claude-opus");
  assert.ok(plan, "budget is fresh after beginTurn");
  assert.equal(plan!.model, "claude-sonnet");
});

// A retry ruleset like a user's "resume when the limit resets" rule.
const retryRuleset: Ruleset = {
  version: 1,
  name: "session-resume",
  appliesTo: ["session"],
  rules: [{ when: ["credits_exhausted", "rate_limited"], action: "retry", maxAttempts: 3 }],
};
const NOW = Date.parse("2026-08-05T22:40:00Z");
function retryController() {
  return new SessionRerouteController({
    policy: createRunPolicy({ ruleset: retryRuleset, context: "session", random: () => 0.5, now: () => NOW }),
  });
}

await check("plans a resume at a weekly limit's reset time", async () => {
  const controller = retryController();
  controller.beginTurn();
  const plan = controller.planResume("You've hit your weekly limit · resets 12am (UTC)", "claude-opus", { now: NOW });
  assert.ok(plan, "should plan a resume");
  assert.equal(plan!.resumeAt, "2026-08-06T00:00:00.000Z");
  assert.equal(plan!.delayMs, 80 * 60 * 1000);
  assert.equal(plan!.condition, "credits_exhausted");
});

await check("prefers a structured reset hint over the ambiguous text time", async () => {
  const controller = retryController();
  controller.beginTurn();
  const plan = controller.planResume("You've hit your weekly limit · resets 12am (UTC)", "claude-opus", {
    now: NOW,
    resetsAtHint: "2026-08-11T00:00:00.000Z",
  });
  assert.equal(plan!.resumeAt, "2026-08-11T00:00:00.000Z");
});

await check("does not defer for ordinary short backoff", async () => {
  // A transport blip under a retry rule → seconds of backoff, not a limit; surface it.
  const controller = new SessionRerouteController({
    policy: createRunPolicy({
      ruleset: { version: 1, name: "t", appliesTo: ["session"], rules: [{ when: ["transport_error"], action: "retry", maxAttempts: 3 }] },
      context: "session",
      random: () => 0.5,
      now: () => NOW,
    }),
  });
  controller.beginTurn();
  assert.equal(controller.planResume("socket hang up", "claude-opus", { now: NOW }), null);
});

await check("floors a past/elapsed reset time so a resume can never be a 0ms tight loop", async () => {
  // A reset that already lapsed (stale text, clock skew, or one that passed while
  // the daemon was down) must not schedule a resume at/before now — that arms a
  // 0ms timer that re-sends, re-hits the limit, and re-schedules 0ms again (100%
  // CPU). The due time is floored to at least MIN_RESUME_DELAY_MS in the future.
  const controller = retryController();
  controller.beginTurn();
  const past = new Date(NOW - 5 * 60 * 1000).toISOString();
  const plan = controller.planResume("rate limit reached", "claude-opus", { now: NOW, resetsAtHint: past });
  assert.ok(plan, "should still plan a resume");
  assert.ok(plan!.delayMs >= 60_000, `delay must be floored, got ${plan!.delayMs}ms`);
  assert.ok(Date.parse(plan!.resumeAt) > NOW, "resumeAt must be strictly in the future");
});

await check("resume budget exhausts after maxAttempts and then parks (no plan)", async () => {
  const controller = retryController();
  controller.beginTurn();
  for (let i = 0; i < 2; i += 1) {
    const plan = controller.planResume("weekly limit reached · resets 12am (UTC)", "claude-opus", { now: NOW });
    assert.ok(plan, `attempt ${i + 1} should still plan a resume`);
    controller.noteResumeApplied();
  }
  // 3rd failure: maxAttempts reached → policy parks → retry no longer returned.
  assert.equal(controller.planResume("weekly limit reached · resets 12am (UTC)", "claude-opus", { now: NOW }), null);
});

await check("a failed model swap reports via onFailed and doesn't throw", async () => {
  const { controller, failedMsgs } = makeController();
  const badTarget: SessionRerouteTarget = {
    getCurrentModelName: () => "claude-opus",
    setModel: async () => {
      throw new Error("model not available on this node");
    },
    reprompt: async () => {
      throw new Error("should not reprompt after a failed swap");
    },
  };
  controller.beginTurn();
  await controller.applyReroute(controller.planReroute("quota exceeded", "claude-opus")!, badTarget);
  assert.equal(failedMsgs.length, 1);
  assert.ok(failedMsgs[0]!.includes("claude-sonnet"));
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log("\nsession-reroute: all tests passed");
