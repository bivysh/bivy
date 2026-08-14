// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { strict as assert } from "node:assert";
import test from "node:test";

import { AGENT_PROFILES } from "../src/agents/profiles.js";

function assertDataOnly(value: unknown, path: string): void {
  assert.notEqual(typeof value, "function", `${path} must contain data, not executable behavior`);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertDataOnly(item, `${path}[${index}]`));
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) assertDataOnly(child, `${path}.${key}`);
  }
}

test("agent profiles are entirely declarative and structured-cloneable", () => {
  assertDataOnly(AGENT_PROFILES, "AGENT_PROFILES");
  assert.doesNotThrow(() => structuredClone(AGENT_PROFILES));
});
