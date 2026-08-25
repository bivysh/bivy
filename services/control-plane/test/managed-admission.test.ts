// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import test from "node:test";
import { activeManagedMachineCount, managedConcurrencyLimit } from "../src/managed-admission.js";

const now = Date.parse("2026-08-25T12:00:00.000Z");

test("managed concurrency counts only live, unexpired operator-owned Machines", () => {
  assert.equal(activeManagedMachineCount([
    { computeSource: "managed", status: "running", createdAt: "2026-08-25T11:30:00.000Z", ttlMinutes: 60 },
    { computeSource: "managed", status: "destroyed", createdAt: "2026-08-25T11:30:00.000Z", ttlMinutes: 60 },
    { computeSource: "managed", status: "running", createdAt: "2026-08-25T09:00:00.000Z", ttlMinutes: 60 },
    { computeSource: "user", status: "running", createdAt: "2026-08-25T11:30:00.000Z", ttlMinutes: 60 },
    { computeSource: "managed", status: "provisioning" },
  ], now), 2);
});

test("managed concurrency limit accepts only positive integers", () => {
  assert.equal(managedConcurrencyLimit("3"), 3);
  assert.equal(managedConcurrencyLimit("0"), undefined);
  assert.equal(managedConcurrencyLimit("1.5"), undefined);
  assert.equal(managedConcurrencyLimit("nope"), undefined);
});
