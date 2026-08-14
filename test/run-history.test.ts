// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { test } from "node:test";
import { runHistoryCategory } from "../packages/web/src/components/RunHistory.js";
import type { AccountAutomationRun } from "@bivy/core";

const run = (status: AccountAutomationRun["status"]): AccountAutomationRun => ({
  id: `run-${status}`, triggerKind: "manual", status, title: status,
  createdAt: "2026-08-13T00:00:00Z",
});

test("Run history separates active, parked, dead-letter, and terminal history", () => {
  assert.equal(runHistoryCategory(run("pending")), "active");
  assert.equal(runHistoryCategory(run("running")), "active");
  assert.equal(runHistoryCategory(run("waiting")), "parked");
  assert.equal(runHistoryCategory(run("needs_attention")), "parked");
  assert.equal(runHistoryCategory(run("failed")), "dead_letter");
  assert.equal(runHistoryCategory(run("succeeded")), "all");
  assert.equal(runHistoryCategory(run("cancelled")), "all");
});
