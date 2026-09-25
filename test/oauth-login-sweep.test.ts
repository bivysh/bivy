// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// The browser-initiated OAuth login registry must reap abandoned in-flight logins
// (aborting them closes the local callback server) and drop finished ones after a
// short grace — otherwise a short-lived ephemeral node leaks login state + an open
// http.Server. Covers the pure sweep decision that src/server.ts drives.
import assert from "node:assert/strict";
import { decideOAuthLoginSweep } from "../src/runtime/oauth/oauth-login-sweep.js";

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures++;
    console.log(`FAIL  ${name}\n      ${error instanceof Error ? error.message : String(error)}`);
  }
}

const OPTS = { ttlMs: 600_000, graceMs: 120_000 };

check("a fresh in-flight login is kept", () => {
  for (const status of ["starting", "waiting"] as const) {
    assert.deepEqual(decideOAuthLoginSweep(status, 5_000, OPTS), { drop: false, abort: false });
  }
});

check("an abandoned in-flight login is aborted AND dropped past its TTL", () => {
  assert.deepEqual(decideOAuthLoginSweep("waiting", OPTS.ttlMs + 1, OPTS), { drop: true, abort: true });
  assert.deepEqual(decideOAuthLoginSweep("starting", OPTS.ttlMs + 1, OPTS), { drop: true, abort: true });
});

check("a finished login is kept within grace, dropped after — never aborted", () => {
  for (const status of ["done", "error"] as const) {
    assert.deepEqual(decideOAuthLoginSweep(status, OPTS.graceMs - 1, OPTS), { drop: false, abort: false });
    assert.deepEqual(decideOAuthLoginSweep(status, OPTS.graceMs + 1, OPTS), { drop: true, abort: false });
  }
});

console.log(`oauth-login-sweep: ${failures} test(s) failed`);
if (failures > 0) process.exit(1);
