// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
// When a refresh-only runner keeps an idle account's synced sign-ins alive.
import assert from "node:assert/strict";
import { signInRefreshDue } from "../src/sign-in-refresh.js";

const DAY = 86_400_000;
const now = Date.parse("2026-11-20T12:00:00Z");
const ago = (days: number) => new Date(now - days * DAY).toISOString();
const due = (nodes: Array<{ online: boolean; lastSeenAt: string | null }>, lastRefreshRunAt?: string) =>
  signInRefreshDue({ now, idleMs: 5 * DAY, nodes, ...(lastRefreshRunAt ? { lastRefreshRunAt } : {}) });

assert.equal(due([{ online: false, lastSeenAt: ago(6) }]), true, "no machine seen for longer than the window: refresh");
assert.equal(due([{ online: false, lastSeenAt: ago(6) }, { online: false, lastSeenAt: ago(2) }]), false, "a machine ran recently and refreshed what it used");
assert.equal(due([{ online: true, lastSeenAt: ago(9) }]), false, "a machine is online now");
assert.equal(due([{ online: false, lastSeenAt: ago(9) }], ago(1)), false, "a refresh run started within the window");
assert.equal(due([]), true, "an account with no machines at all");
console.log("sign-in-refresh: all tests passed");
