import assert from "node:assert/strict";
import { evaluateForkPrereqs, blockingForkPrereqs, missingForkPrereqs } from "../src/session/fork-prereqs.js";

// Fork prerequisite detection: the agent is a hard blocker; model + repo are
// soft (surfaced but non-blocking). See docs/session-fork-plan.md.

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

test("all satisfied → nothing missing, nothing blocking", () => {
  const p = evaluateForkPrereqs({
    agent: { id: "pi", displayName: "Pi", available: true },
    model: { provider: "anthropic", configured: true },
    repo: { slug: "o/r", reachable: true },
  });
  assert.equal(missingForkPrereqs(p).length, 0);
  assert.equal(blockingForkPrereqs(p).length, 0);
  assert.ok(p.every((x) => x.ok));
});

test("missing agent is blocking and carries an install fix", () => {
  const p = evaluateForkPrereqs({ agent: { id: "claude", displayName: "Claude Code", available: false } });
  const blocking = blockingForkPrereqs(p);
  assert.equal(blocking.length, 1);
  assert.equal(blocking[0].kind, "agent");
  assert.equal(blocking[0].fix, "runtime.install");
});

test("missing model/repo are surfaced but NOT blocking", () => {
  const p = evaluateForkPrereqs({
    agent: { id: "pi", displayName: "Pi", available: true },
    model: { provider: "openai", configured: false },
    repo: { slug: "o/r", reachable: false },
  });
  assert.equal(blockingForkPrereqs(p).length, 0, "neither model nor repo blocks");
  const missing = missingForkPrereqs(p);
  assert.deepEqual(missing.map((x) => x.kind).sort(), ["model", "repo"]);
  assert.equal(missing.find((x) => x.kind === "model")!.fix, "provider.connect");
  assert.equal(missing.find((x) => x.kind === "repo")!.fix, "github.connect");
});

test("model/repo omitted when not applicable (non-repo, single-provider)", () => {
  const p = evaluateForkPrereqs({ agent: { id: "pi", displayName: "Pi", available: true } });
  assert.equal(p.length, 1);
  assert.equal(p[0].kind, "agent");
});

console.log(`fork-prereqs: all ${passed} tests passed`);
