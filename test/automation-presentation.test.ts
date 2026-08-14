import assert from "node:assert/strict";
import test from "node:test";
import { compactCronSummary, formatAutomationMoment, formatNextAutomationRun } from "../packages/web/src/automationPresentation.js";

const now = new Date(2026, 7, 13, 9, 0);

test("automation dates use relative labels for nearby runs", () => {
  assert.equal(formatAutomationMoment(new Date(2026, 7, 13, 20, 19), { now, locale: "en-GB" }), "Today at 20:19");
  assert.equal(formatAutomationMoment(new Date(2026, 7, 14, 12, 0), { now, locale: "en-GB" }), "Tomorrow at 12:00");
  assert.equal(formatAutomationMoment(new Date(2026, 7, 15, 8, 30), { now, locale: "en-GB" }), "Saturday at 08:30");
});

test("next-run copy reads as metadata rather than a raw timestamp", () => {
  assert.equal(formatNextAutomationRun(new Date(2026, 7, 14, 12, 0), { now, locale: "en-GB" }), "Next tomorrow");
  assert.equal(formatNextAutomationRun(new Date(2026, 7, 13, 20, 19), { now, locale: "en-GB" }), "Next today at 20:19");
});

test("automation dates retain the year when needed", () => {
  assert.match(formatAutomationMoment(new Date(2027, 0, 3, 9, 5), { now, locale: "en-GB" }), /^3 Jan 2027 at 09:05$/);
});

test("common cron schedules use compact list copy", () => {
  assert.equal(compactCronSummary("0 12 * * *", "en-GB"), "Daily at 12:00");
  assert.equal(compactCronSummary("0 9 * * 1", "en-GB"), "Every Monday at 9:00");
  assert.equal(compactCronSummary("30 8 1 * *", "en-GB"), "Monthly on day 1 at 8:30");
  assert.equal(compactCronSummary("*/15 * * * *", "en-GB"), null);
});
