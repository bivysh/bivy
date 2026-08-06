// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Unit tests for the natural-language → cron translator used by the Automations
// schedule UI. Also structurally checks every produced expression is a valid
// standard five-field cron (the shape the control plane's cron-parser accepts —
// no Quartz `?`/`L`/seconds/year tokens) so the UI can never hand the backend a
// cron it would reject.
import assert from "node:assert/strict";
import { nlToCron, isNlCronOk } from "../packages/core/src/nl-cron.js";

// A standard five-field cron: minute hour day-of-month month day-of-week, where
// every field is only the portable tokens (`*`, numbers, `,`, `-`, `*/n`).
function assertFiveFieldCron(cron: string, ctx: string): void {
  const fields = cron.split(" ");
  assert.equal(fields.length, 5, `expected 5 fields in ${JSON.stringify(cron)} for ${ctx}`);
  for (const f of fields) {
    assert.match(f, /^(\*|\*\/\d+|\d+(-\d+)?)(,(\d+(-\d+)?))*$/, `field ${JSON.stringify(f)} in ${JSON.stringify(cron)} for ${ctx}`);
  }
}

const CASES: Array<[string, string]> = [
  ["every day at 1pm", "0 13 * * *"],
  ["every day at 1:00 pm", "0 13 * * *"],
  ["daily at noon", "0 12 * * *"],
  ["at 6am every day", "0 6 * * *"],
  ["every day at midnight", "0 0 * * *"],
  ["every monday at 9am", "0 9 * * 1"],
  ["every weekday at 8:30am", "30 8 * * 1,2,3,4,5"],
  ["weekdays at 8:30am", "30 8 * * 1,2,3,4,5"],
  ["every friday at 5pm", "0 17 * * 5"],
  ["mondays and thursdays at 6am", "0 6 * * 1,4"],
  ["every weekend at 10am", "0 10 * * 0,6"],
  ["every hour", "0 * * * *"],
  ["hourly", "0 * * * *"],
  ["every 15 minutes", "*/15 * * * *"],
  ["every 5 min", "*/5 * * * *"],
  ["every minute", "* * * * *"],
  ["every 2 hours", "0 */2 * * *"],
  ["every sunday", "0 0 * * 0"],
  ["every month on the 1st at midnight", "0 0 1 * *"],
  ["on the 15th at 9am", "0 9 15 * *"],
  ["every day at 13:30", "30 13 * * *"],
  ["at 9am and 5pm", "0 9,17 * * *"],
];

function main() {
  for (const [phrase, expected] of CASES) {
    const r = nlToCron(phrase);
    assert.ok(isNlCronOk(r), `expected a cron for ${JSON.stringify(phrase)}, got error: ${JSON.stringify(r)}`);
    assert.equal(r.cron, expected, `for ${JSON.stringify(phrase)}`);
    assertFiveFieldCron(r.cron, JSON.stringify(phrase));
  }

  // Phrases with no recognizable time/day should surface a helpful error rather
  // than silently producing a wrong (or every-minute) schedule.
  for (const phrase of ["", "   ", "banana", "sometime soon", "every day"]) {
    const r = nlToCron(phrase);
    assert.ok(!isNlCronOk(r), `expected an error for ${JSON.stringify(phrase)}, got ${JSON.stringify(r)}`);
  }

  // Ambiguous multi-time (different minutes) is rejected — cron can't express it.
  assert.ok(!isNlCronOk(nlToCron("at 9:00am and 5:30pm")));

  console.log(`nl-cron: ${CASES.length} translations + guardrails passed`);
}

main();
