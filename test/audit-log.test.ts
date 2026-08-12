// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createAuditLog, readAuditEvents } from "../src/audit/index.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bivy-audit-"));
}

test("record appends JSONL, stamps ts, and round-trips", () => {
  const dir = tmpDir();
  const log = createAuditLog(dir);
  log.record({ kind: "tool.call", session: "s1", agent: "pi", tool: "bash", decision: "allowed" });
  log.record({ kind: "tool.call", session: "s1", agent: "pi", tool: "write", decision: "blocked", reason: "outside workspace" });

  const events = readAuditEvents(log.file);
  assert.equal(events.length, 2);
  assert.equal(events[0].kind, "tool.call");
  assert.equal(events[0].tool, "bash");
  assert.equal(events[0].decision, "allowed");
  assert.equal(typeof events[0].ts, "number");
  assert.equal(events[1].decision, "blocked");
  assert.equal(events[1].reason, "outside workspace");
});

test("filters by session and kind, and honours limit (most-recent)", () => {
  const dir = tmpDir();
  const log = createAuditLog(dir);
  log.record({ kind: "tool.call", session: "a", tool: "bash", decision: "allowed" });
  log.record({ kind: "net.attempt", session: "a", host: "example.com", decision: "allowed" });
  log.record({ kind: "tool.call", session: "b", tool: "bash", decision: "allowed" });

  assert.equal(readAuditEvents(log.file, { session: "a" }).length, 2);
  assert.equal(readAuditEvents(log.file, { kind: "tool.call" }).length, 2);
  assert.equal(readAuditEvents(log.file, { session: "a", kind: "tool.call" }).length, 1);
  const last = readAuditEvents(log.file, { limit: 1 });
  assert.equal(last.length, 1);
  assert.equal(last[0].session, "b");
});

test("malformed lines are skipped, and a missing file reads empty", () => {
  const dir = tmpDir();
  const file = path.join(dir, "audit.jsonl");
  assert.deepEqual(readAuditEvents(file), []); // missing file
  fs.writeFileSync(file, '{"ts":1,"kind":"tool.call"}\nnot json\n{"ts":2,"kind":"net.attempt"}\n');
  const events = readAuditEvents(file);
  assert.equal(events.length, 2);
});

test("record never throws when the dir is unwritable (best-effort)", () => {
  // Point at a path under a file (can't mkdir), so append fails internally.
  const dir = tmpDir();
  const blocker = path.join(dir, "blocker");
  fs.writeFileSync(blocker, "x");
  const log = createAuditLog(path.join(blocker, "nope"));
  assert.doesNotThrow(() => log.record({ kind: "tool.call", session: "s", decision: "allowed" }));
});
