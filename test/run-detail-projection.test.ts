// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { test } from "node:test";
import { projectRunDetail } from "../packages/web/src/runDetail.js";

test("Run detail keeps ambiguous process completion at Needs review", () => {
  const detail = projectRunDetail({ status: "succeeded", output: { sessionId: "s1" } });
  assert.equal(detail.outcome.kind, "needs_review");
  assert.deepEqual(detail.availableActions, ["open_session"]);
});

test("Run detail prioritizes deterministic check failure over agent success", () => {
  const detail = projectRunDetail({
    status: "succeeded",
    attempt: 2,
    runtimeId: "claude-code",
    model: "sonnet",
    checks: [
      { name: "test", status: "failed", exitCode: 1 },
      { name: "lint", status: "passed", exitCode: 0 },
    ],
    output: { sessionId: "s1", prUrl: "https://github.com/o/r/pull/1" },
  });
  assert.equal(detail.outcome.kind, "checks_failed");
  assert.equal(detail.checksSummary, "1 passed · 1 failed");
  assert.equal(detail.attempt, 2);
  assert.equal(detail.agent, "claude-code · sonnet");
  assert.equal(detail.artifact?.kind, "pull_request");
  assert.deepEqual(detail.availableActions, ["open_session", "view_pull_request"]);
});

test("Run detail exposes a checked PR outcome from durable references", () => {
  const detail = projectRunDetail({
    status: "succeeded",
    checks: [{ name: "test", status: "passed" }],
    output: { prUrl: "https://github.com/o/r/pull/2" },
  });
  assert.equal(detail.outcome.kind, "pr_open");
  assert.equal(detail.artifact?.label, "Pull request");
});
