// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import test from "node:test";
import { isListedAutomation } from "../packages/web/src/automationList.js";

test("one-off schedules stay out of the persistent automations list", () => {
  assert.equal(isListedAutomation({ schedule: { kind: "once", at: "2026-08-27T09:00:00.000Z" } }), false);
  assert.equal(isListedAutomation({ schedule: { kind: "cron", expression: "0 9 * * *", timezone: "UTC" } }), true);
});
