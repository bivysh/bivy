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

test("file.change records path + line counts, never content", () => {
  const dir = tmpDir();
  const log = createAuditLog(dir);
  log.record({ kind: "file.change", session: "s1", agent: "pi", path: "src/app.ts", op: "modified", added: 12, removed: 3 });
  log.record({ kind: "file.change", session: "s1", agent: "pi", path: "src/gone.ts", op: "deleted" });

  const events = readAuditEvents(log.file, { kind: "file.change" });
  assert.equal(events.length, 2);
  assert.equal(events[0].path, "src/app.ts");
  assert.equal(events[0].op, "modified");
  assert.equal(events[0].added, 12);
  assert.equal(events[0].removed, 3);
  // Redaction: the diff text must never be present on the record.
  assert.equal("oldText" in events[0], false);
  assert.equal("newText" in events[0], false);
  assert.equal(events[1].op, "deleted");
  assert.equal(events[1].added, undefined);
});

test("cost records rolling totals and is queryable by kind", () => {
  const dir = tmpDir();
  const log = createAuditLog(dir);
  log.record({ kind: "cost", session: "s1", agent: "pi", costUsd: 0.0123, tokens: 4200 });
  const events = readAuditEvents(log.file, { kind: "cost" });
  assert.equal(events.length, 1);
  assert.equal(events[0].costUsd, 0.0123);
  assert.equal(events[0].tokens, 4200);
});

test("record never throws when the dir is unwritable (best-effort)", () => {
  // Point at a path under a file (can't mkdir), so append fails internally.
  const dir = tmpDir();
  const blocker = path.join(dir, "blocker");
  fs.writeFileSync(blocker, "x");
  const log = createAuditLog(path.join(blocker, "nope"));
  assert.doesNotThrow(() => log.record({ kind: "tool.call", session: "s", decision: "allowed" }));
});

test("net.attempt and approval events round-trip their metadata", () => {
  const dir = tmpDir();
  const log = createAuditLog(dir);
  log.record({ kind: "net.attempt", session: "s1", agent: "pi", host: "api.example.com", port: 443, decision: "allowed" });
  log.record({ kind: "net.attempt", session: "s1", host: "evil.test", port: 80, decision: "blocked", reason: "not on allowlist" });
  log.record({ kind: "approval.request", session: "s1", agent: "pi", tool: "bash", requestId: "r1" });
  log.record({ kind: "approval.decision", session: "s1", agent: "pi", tool: "bash", requestId: "r1", approved: true });

  const net = readAuditEvents(log.file, { kind: "net.attempt" });
  assert.equal(net.length, 2);
  assert.equal(net[0].host, "api.example.com");
  assert.equal(net[0].port, 443);
  assert.equal(net[0].decision, "allowed");
  assert.equal(net[0].agent, "pi");
  assert.equal(net[1].decision, "blocked");
  assert.equal(net[1].reason, "not on allowlist");

  const req = readAuditEvents(log.file, { kind: "approval.request" });
  assert.equal(req.length, 1);
  assert.equal(req[0].tool, "bash");
  assert.equal(req[0].requestId, "r1");

  const dec = readAuditEvents(log.file, { kind: "approval.decision" });
  assert.equal(dec.length, 1);
  assert.equal(dec[0].approved, true);
  assert.equal(dec[0].requestId, "r1");
  assert.equal(dec[0].tool, "bash");
});
