// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  recordDurableRunLifecycleResult,
  type RunLifecycleOutcome,
} from "../src/metrics.js";

test("durable Run results record each fixed outcome exactly once", () => {
  const calls: RunLifecycleOutcome[] = [];
  const recorder = (outcome: RunLifecycleOutcome) => calls.push(outcome);

  const run = { status: "persisted" };
  assert.equal(recordDurableRunLifecycleResult(run, "succeeded", recorder), run);
  recordDurableRunLifecycleResult(run, "failed", recorder);
  recordDurableRunLifecycleResult(run, "needs_attention", recorder);

  assert.deepEqual(calls, ["succeeded", "failed", "needs_attention"]);
});

test("unsuccessful durable transitions do not record a result", () => {
  const calls: RunLifecycleOutcome[] = [];
  recordDurableRunLifecycleResult(null, "failed", (outcome) => calls.push(outcome));
  recordDurableRunLifecycleResult(undefined, "needs_attention", (outcome) => calls.push(outcome));
  assert.deepEqual(calls, []);
});
