// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PROTOCOL_VERSION,
  LEGACY_PROTOCOL_VERSION,
  isServedTo,
  negotiateVersion,
  compatibleSubset,
} from "../src/protocol/version.js";

test("legacy is v0 and the node speaks at least v1", () => {
  assert.equal(LEGACY_PROTOCOL_VERSION, 0);
  assert.ok(PROTOCOL_VERSION >= 1);
});

test("isServedTo: a client is served ops introduced at or before its version", () => {
  // A legacy (v0) op is served to everyone, including legacy clients.
  assert.equal(isServedTo({ since: 0 }, 0), true);
  assert.equal(isServedTo({ since: 0 }, 1), true);
  // A v1 op is withheld from a v0 client, served to a v1 client.
  assert.equal(isServedTo({ since: 1 }, 0), false);
  assert.equal(isServedTo({ since: 1 }, 1), true);
});

test("negotiateVersion: clamp to [legacy, node], meet the client where it is", () => {
  assert.equal(negotiateVersion(undefined), 0, "missing → legacy");
  assert.equal(negotiateVersion(0), 0);
  assert.equal(negotiateVersion(1), Math.min(1, PROTOCOL_VERSION));
  assert.equal(negotiateVersion(999), PROTOCOL_VERSION, "future client clamps to node");
  assert.equal(negotiateVersion(-5), 0, "negative → legacy, never rejects");
  assert.equal(negotiateVersion(NaN), 0);
  assert.equal(negotiateVersion(1.9), 1, "truncates");
});

test("compatibleSubset: serve exactly the subset a client understands", () => {
  const ops: Array<[string, { since: number }]> = [
    ["a.legacy", { since: 0 }],
    ["b.legacy", { since: 0 }],
    ["c.v1", { since: 1 }],
  ];
  const forLegacy = compatibleSubset(ops, 0);
  assert.deepEqual([...forLegacy.keys()].sort(), ["a.legacy", "b.legacy"]);
  const forV1 = compatibleSubset(ops, 1);
  assert.deepEqual([...forV1.keys()].sort(), ["a.legacy", "b.legacy", "c.v1"]);
});
