// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import test from "node:test";
import { accountHeader, accountOffer, formatWhen, planFacts } from "../packages/web/src/accountHeader.js";
import { parseClientConfiguration } from "../packages/web/src/client-config.js";

const visible = parseClientConfiguration();
const upgrade = { id: "checkout", label: "Upgrade", kind: "primary" as const };
const ext = (used: number, limit = 10) => ({
  summary: "Free",
  meter: { label: "Sessions this week", used, limit },
  actions: [{ id: "portal", label: "Manage", kind: "secondary" as const }, upgrade],
});

test("account header nudges only once the allowance is nearly or fully used", () => {
  assert.deepEqual(accountHeader(ext(3), visible), {
    summary: "Free",
    meter: { label: "Sessions this week", used: 3, limit: 10, state: "ok" },
  });
  assert.deepEqual(accountHeader(ext(8), visible).meter?.state, "near");
  assert.deepEqual(accountHeader(ext(8), visible).action, { id: "checkout", label: "Upgrade" });
  // Overuse clamps to the limit rather than drawing past the bar.
  const reached = accountHeader(ext(14), visible);
  assert.deepEqual([reached.meter?.used, reached.meter?.state, reached.action?.id], [10, "reached", "checkout"]);
});

test("account header follows the client's extension visibility", () => {
  assert.deepEqual(accountHeader(ext(10), parseClientConfiguration(JSON.stringify({ accountExtension: "hidden" }))), {});
  const facts = parseClientConfiguration(JSON.stringify({
    accountExtension: "facts",
    accountMessageRules: [{ terms: ["Free"], replacement: "See the website" }],
  }));
  // Store builds see usage but no purchase action, and flagged text is dropped.
  assert.deepEqual(accountHeader(ext(10), facts), { meter: { label: "Sessions this week", used: 10, limit: 10, state: "reached" } });
});

test("account header ignores a malformed meter", () => {
  for (const meter of [{ label: "x", used: 1, limit: 0 }, { label: "", used: 1, limit: 5 }, { label: "x", used: Number.NaN, limit: 5 }]) {
    assert.deepEqual(accountHeader({ summary: "Cloud", meter }, visible), { summary: "Cloud" });
  }
});

test("account header says when a slot frees up, once the allowance is running out", () => {
  const now = new Date(2026, 9, 1, 10, 0);
  const at = (freesAt: Date, used: number) => accountHeader({ meter: { label: "Sessions", used, limit: 10, freesAt: freesAt.toISOString() } }, visible, now).meter?.freesNote;
  assert.equal(at(new Date(2026, 9, 1, 10, 25), 10), "A slot frees up in 25 min");
  assert.match(at(new Date(2026, 9, 2, 14, 0), 8)!, /^A slot frees up tomorrow at /);
  assert.equal(at(new Date(2026, 9, 2, 14, 0), 3), undefined, "no note while there is plenty left");
  assert.equal(at(new Date(2026, 9, 1, 9, 0), 10), undefined, "a time already past is stale");
});

test("formatWhen names the day plainly and adds the date only when a weekday would be ambiguous", () => {
  const now = new Date(2026, 9, 1, 10, 0); // Thu 1 Oct
  const when = (d: Date) => formatWhen(d, now, "en-GB");
  assert.equal(when(new Date(2026, 9, 1, 18, 30)), "today at 18:30");
  assert.equal(when(new Date(2026, 9, 2, 9, 5)), "tomorrow at 09:05");
  assert.equal(when(new Date(2026, 9, 5, 14, 0)), "Mon at 14:00");
  assert.equal(when(new Date(2026, 9, 8, 9, 0)), "Thu 8 Oct at 09:00");
});

test("the offer card needs one of the extension's own actions and a client that may show actions", () => {
  const extension = {
    actions: [upgrade],
    offer: { title: "Bivy Cloud", price: "$15/month", description: " ", points: ["Unlimited sessions", ""], action: "checkout" },
  };
  assert.deepEqual(accountOffer(extension, visible), {
    title: "Bivy Cloud", price: "$15/month", description: undefined, points: ["Unlimited sessions"], action: { id: "checkout", label: "Upgrade" },
  });
  assert.equal(accountOffer({ ...extension, offer: { ...extension.offer, action: "nope" } }, visible), undefined);
  assert.equal(accountOffer(extension, parseClientConfiguration(JSON.stringify({ accountExtension: "facts" }))), undefined);
});

test("facts the meter already shows are left to the meter", () => {
  const facts = [{ id: "plan", label: "Plan", value: "Free" }, { id: "s", label: "Sessions this week", value: "8 of 10 used" }];
  assert.deepEqual(planFacts(facts, ext(8)).map((f) => f.id), ["plan"]);
  assert.deepEqual(planFacts(facts, { summary: "Cloud" }).map((f) => f.id), ["plan", "s"]);
});
