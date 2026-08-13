// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  recordDurableRunLifecycleResult,
  classifyRunFailureStage,
  type RunLifecycleOutcome,
  PRODUCT_EVENT_VALUES,
  PRODUCT_CLIENT_VALUES,
} from "../src/metrics.js";

test("durable Run results record each fixed outcome exactly once", () => {
  const calls: RunLifecycleOutcome[] = [];
  const recorder = (outcome: RunLifecycleOutcome) => calls.push(outcome);

  const run = { status: "persisted" };
  assert.equal(recordDurableRunLifecycleResult(run, "succeeded", recorder), run);
  recordDurableRunLifecycleResult(run, "failed", recorder);
  recordDurableRunLifecycleResult(run, "needs_attention", recorder);
  recordDurableRunLifecycleResult(run, "cancelled", recorder);

  assert.deepEqual(calls, ["succeeded", "failed", "needs_attention", "cancelled"]);
});

test("product metric dimensions are closed low-cardinality enums", () => {
  assert.deepEqual(PRODUCT_EVENT_VALUES, [
    "activation_ready",
    "first_useful_response",
    "remote_reconnect",
    "remote_intervention",
    "run_accepted",
    "receipt_reviewed",
    "first_run_machine_ready",
    "first_run_machine_failed",
    "first_run_provider_connected",
    "first_run_provider_failed",
    "first_run_agent_verified",
    "first_run_agent_failed",
  ]);
  assert.deepEqual(PRODUCT_CLIENT_VALUES, ["desktop", "mobile", "cli", "node"]);
});

test("unsuccessful durable transitions do not record a result", () => {
  const calls: RunLifecycleOutcome[] = [];
  recordDurableRunLifecycleResult(null, "failed", (outcome) => calls.push(outcome));
  recordDurableRunLifecycleResult(undefined, "needs_attention", (outcome) => calls.push(outcome));
  assert.deepEqual(calls, []);
});

test("failure stage is a fixed enum derived from durable evidence", () => {
  // A failed deterministic check dominates any other signal.
  assert.equal(classifyRunFailureStage({ checks: [{ status: "failed" }], output: { failure: "timed out" } }), "checks");
  // Timeout signature in the bounded failure summary.
  assert.equal(classifyRunFailureStage({ output: { failure: "Agent turn timed out after 60 minutes" } }), "timeout");
  assert.equal(classifyRunFailureStage({ output: { failure: "wall-clock timeout" } }), "timeout");
  // Otherwise the agent itself failed.
  assert.equal(classifyRunFailureStage({ output: { failure: "runtime exited 1" } }), "agent");
  assert.equal(classifyRunFailureStage({}), "agent");
  assert.equal(classifyRunFailureStage(null), "agent");
  // A parked (needs-attention) Run is reviewable, not an outright failure.
  assert.equal(classifyRunFailureStage({ checks: [{ status: "failed" }] }, true), "needs_review");
});
