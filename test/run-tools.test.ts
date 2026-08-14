// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import test from "node:test";
import { RunDelegationService, RUN_TOOL_LIMITS, delegationSource, parseDelegationSource, type RunDelegationBackend, type StartRunInput } from "../src/run-tools.js";

function fixture(options: { depth?: number } = {}) {
  let clock = 0;
  const runs = new Map<string, Record<string, unknown>>();
  let sequence = 0;
  const backend: RunDelegationBackend = {
    parentContext: (sessionId) => sessionId === "parent" ? { parentRunId: "run-parent", depth: options.depth ?? 0 } : undefined,
    listRecent: async () => [...runs.values()],
    get: async (id) => runs.get(id),
    start: async (_sessionId, input: StartRunInput, provenance) => {
      const run = { id: `child-${++sequence}`, status: "pending", source: delegationSource(provenance.parentSessionId, provenance.parentRunId, provenance.depth, input.idempotencyKey), createdAt: "2026-01-01T00:00:00Z", body: "ciphertext-must-not-surface", transcript: "secret", output: {} };
      runs.set(String(run.id), run);
      return run;
    },
  };
  const service = new RunDelegationService(backend, () => clock, async (ms) => { clock += ms; });
  return { service, runs, backend, advance: (ms: number) => { clock += ms; } };
}

test("delegation provenance is content-free, reversible, and bounded", () => {
  const source = delegationSource("session/a", "run/b", 2);
  assert.deepEqual(parseDelegationSource(source), { parentSessionId: "session/a", parentRunId: "run/b", depth: 2 });
  assert.equal(parseDelegationSource(delegationSource("s", undefined, 3))?.parentRunId, undefined);
  assert.equal(parseDelegationSource("agent-delegation:v1:4:cw:-"), undefined);
});

test("start/status returns safe references only and rejects cross-parent enumeration", async () => {
  const { service, runs, advance } = fixture();
  const started = await service.startRun("parent", { instructions: "Review this branch", repo: "bivysh/bivy", agent: "pi", model: "gpt-5.6-sol" });
  assert.equal(started.provenance.depth, 1);
  const raw = runs.get(started.runId)!;
  raw.status = "succeeded";
  raw.output = { sessionId: "safe-session", branch: "review/result", prUrl: "https://github.com/bivysh/bivy/pull/999", artifactUrl: "https://example.test/a", failure: undefined, secret: "never" };
  raw.checks = [{ name: "tests", status: "passed", exitCode: 0, output: "raw output" }];
  advance(RUN_TOOL_LIMITS.minPollMs);
  const status = await service.getRunStatus("parent", started.runId);
  assert.deepEqual(status.references, { sessionId: "safe-session", branch: "review/result", prUrl: "https://github.com/bivysh/bivy/pull/999", artifactUrl: "https://example.test/a", failure: undefined });
  assert.deepEqual(status.checks, [{ name: "tests", status: "passed", exitCode: 0 }]);
  assert.equal(JSON.stringify(status).includes("ciphertext"), false);
  assert.equal(JSON.stringify(status).includes("raw output"), false);
  await assert.rejects(service.getRunStatus("another-parent", started.runId), /not found/);
  await assert.rejects(service.getRunStatus("parent", "unknown"), /not found/);
});

test("nesting and concurrent children are capped", async () => {
  const nested = fixture({ depth: RUN_TOOL_LIMITS.maxDepth });
  await assert.rejects(nested.service.startRun("parent", { instructions: "too deep" }), /depth limit/);
  const active = fixture();
  for (let i = 0; i < RUN_TOOL_LIMITS.maxConcurrentChildren; i++) await active.service.startRun("parent", { instructions: `child ${i}` });
  await assert.rejects(active.service.startRun("parent", { instructions: "one too many" }), /concurrent child Run limit/);
  const retry = await active.service.startRun("parent", { instructions: "idempotent review", idempotencyKey: "review-1" }).catch(() => undefined);
  assert.equal(retry, undefined, "a new keyed child is still bounded at capacity");
  active.runs.get("child-1")!.status = "cancelled";
  const keyed = await active.service.startRun("parent", { instructions: "replacement", idempotencyKey: "review-1" });
  assert.equal(keyed.runId, "child-4");
  active.runs.get("child-4")!.status = "running";
  assert.equal((await active.service.startRun("parent", { instructions: "replacement retry", idempotencyKey: "review-1" })).runId, "child-4", "an idempotent retry is returned even at capacity");
});

test("wait reports success, failure, cancellation, and timeout without claiming cancellation", async () => {
  for (const terminal of ["succeeded", "failed", "cancelled"] as const) {
    const f = fixture();
    const child = await f.service.startRun("parent", { instructions: "run tests" });
    f.runs.get(child.runId)!.status = terminal;
    const done = await f.service.waitForRun("parent", child.runId, 10);
    assert.equal(done.status, terminal);
    assert.equal(done.timedOut, undefined);
  }
  const f = fixture();
  const child = await f.service.startRun("parent", { instructions: "GPU job" });
  const timed = await f.service.waitForRun("parent", child.runId, 2);
  assert.equal(timed.timedOut, true);
  assert.deepEqual(timed.wait, { timedOut: true, childContinues: true });
  assert.equal(f.runs.get(child.runId)!.status, "pending");
  await assert.rejects(f.service.waitForRun("parent", child.runId, RUN_TOOL_LIMITS.maxWaitSeconds + 1), /timeoutSeconds/);
});
