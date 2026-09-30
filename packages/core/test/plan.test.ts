// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { describe, it, expect } from "vitest";
import { latestPlan, planUpdateOf } from "../src/plan.js";

describe("plan", () => {
  it("reads Codex, ACP and todo-tool plans into one status vocabulary", () => {
    expect(latestPlan([{ explanation: "x", plan: [{ step: "Inspect", status: "inProgress" }] }])).toEqual([{ text: "Inspect", status: "in_progress" }]);
    expect(latestPlan([{ entries: [{ content: "Ship", priority: "high", status: "completed" }] }])).toEqual([{ text: "Ship", status: "completed" }]);
    expect(latestPlan([{ todos: [{ content: "Drop", status: "cancelled", id: 3 }] }])).toEqual([{ text: "Drop", status: "cancelled", id: "3" }]);
  });

  it("is not a plan without a list of steps (a plan-mode proposal is prose)", () => {
    expect(planUpdateOf({ plan: "1. do it" })).toBeUndefined();
    expect(planUpdateOf({ todos: [] })).toBeUndefined();
  });
});
