// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { test } from "node:test";
import assert from "node:assert/strict";

import { createForkRetire, type ForkRetireDeps } from "../src/session/fork-retire.js";

function harness(over: Partial<ForkRetireDeps> = {}) {
  const calls: { deleted: string[] } = { deleted: [] };
  const existing = new Set<string>(["src-1"]);
  const deps: ForkRetireDeps = {
    sessionExists: (id) => existing.has(id),
    deleteSession: async (id) => { calls.deleted.push(id); existing.delete(id); },
    ...over,
  };
  return { calls, existing, retire: createForkRetire(deps) };
}

test("refuses to retire without a confirmed destination (no silent loss)", async () => {
  const { calls, retire } = harness();
  const out = await retire.retireSource({ sourceSessionId: "src-1", newSessionId: "" });
  assert.equal(out.ok, false);
  if (!out.ok) assert.match(out.error, /confirmed destination/);
  assert.deepEqual(calls.deleted, [], "source is NOT deleted when the move is unconfirmed");
});

test("requires a source id", async () => {
  const { retire } = harness();
  const out = await retire.retireSource({ sourceSessionId: "", newSessionId: "dst-1" });
  assert.equal(out.ok, false);
});

test("retires the source once the destination is confirmed", async () => {
  const { calls, existing, retire } = harness();
  const out = await retire.retireSource({ sourceSessionId: "src-1", newSessionId: "dst-1" });
  assert.deepEqual(out, { ok: true, retired: true, alreadyGone: false });
  assert.deepEqual(calls.deleted, ["src-1"]);
  assert.equal(existing.has("src-1"), false);
});

test("is idempotent — a retry after the source is gone succeeds without deleting again", async () => {
  const { calls, retire } = harness();
  await retire.retireSource({ sourceSessionId: "src-1", newSessionId: "dst-1" }); // first: deletes
  const second = await retire.retireSource({ sourceSessionId: "src-1", newSessionId: "dst-1" }); // retry
  assert.deepEqual(second, { ok: true, retired: false, alreadyGone: true });
  assert.deepEqual(calls.deleted, ["src-1"], "delete happened exactly once across the retry");
});
