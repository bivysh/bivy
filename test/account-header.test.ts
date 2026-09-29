// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import test from "node:test";
import { accountHeader } from "../packages/web/src/accountHeader.js";
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
