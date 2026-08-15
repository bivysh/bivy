// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createAuditLog, readAuditEvents } from "../src/audit/index.js";
import { canonicalize, chainHash, loadOrCreateAuditKey, verifyAuditChain } from "../src/audit/integrity.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bivy-audit-integ-"));
}

function lines(file: string): Record<string, unknown>[] {
  return fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

test("canonicalize is key-order independent", () => {
  assert.equal(canonicalize({ b: 1, a: 2 }), canonicalize({ a: 2, b: 1 }));
  assert.equal(canonicalize({ a: { y: 1, x: 2 } }), '{"a":{"x":2,"y":1}}');
  assert.notEqual(canonicalize({ a: 1 }), canonicalize({ a: 2 }));
});

test("chainHash binds prev + entry", () => {
  const h1 = chainHash("", { kind: "tool.call", seq: 0 });
  const h2 = chainHash(h1, { kind: "tool.call", seq: 1 });
  assert.notEqual(h1, h2);
  // Same inputs → same hash (deterministic).
  assert.equal(chainHash("", { kind: "tool.call", seq: 0 }), h1);
});

test("signed chain verifies end-to-end", () => {
  const dir = tmpDir();
  const key = loadOrCreateAuditKey(dir);
  const log = createAuditLog(dir, { signer: key.signer });
  log.record({ kind: "tool.call", session: "s1", agent: "pi", tool: "bash", decision: "allowed" });
  log.record({ kind: "approval.request", session: "s1", tool: "write", requestId: "r1" });
  log.record({ kind: "approval.decision", session: "s1", tool: "write", requestId: "r1", approved: true });

  const res = verifyAuditChain(log.file, { publicKeys: { [key.keyId]: key.publicKeyPem } });
  assert.equal(res.ok, true);
  assert.equal(res.total, 3);
  assert.equal(res.verified, 3);
  assert.equal(res.signaturesVerified, 3);
  assert.equal(res.unprotectedPrefix, 0);

  // Existing readers still work despite the extra chain fields.
  const events = readAuditEvents(log.file, { session: "s1" });
  assert.equal(events.length, 3);
  assert.equal(events[0].tool, "bash");
});

test("in-place edit of a field is detected", () => {
  const dir = tmpDir();
  const key = loadOrCreateAuditKey(dir);
  const log = createAuditLog(dir, { signer: key.signer });
  log.record({ kind: "tool.call", tool: "bash", decision: "blocked", reason: "catastrophic" });
  log.record({ kind: "tool.call", tool: "read", decision: "allowed" });

  const rows = lines(log.file);
  // Attacker flips a blocked decision to allowed but can't recompute the hash/sig.
  rows[0].decision = "allowed";
  fs.writeFileSync(log.file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

  const res = verifyAuditChain(log.file, { publicKeys: { [key.keyId]: key.publicKeyPem } });
  assert.equal(res.ok, false);
  assert.equal(res.brokenAt, 1);
  assert.match(res.reason ?? "", /hash mismatch/);
});

test("deleting a middle entry breaks the linkage", () => {
  const dir = tmpDir();
  const key = loadOrCreateAuditKey(dir);
  const log = createAuditLog(dir, { signer: key.signer });
  log.record({ kind: "tool.call", tool: "a" });
  log.record({ kind: "tool.call", tool: "b" });
  log.record({ kind: "tool.call", tool: "c" });

  const rows = lines(log.file);
  rows.splice(1, 1); // remove the middle entry
  fs.writeFileSync(log.file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

  const res = verifyAuditChain(log.file, { publicKeys: { [key.keyId]: key.publicKeyPem } });
  assert.equal(res.ok, false);
  assert.equal(res.brokenAt, 2);
});

test("forged entry without the key fails signature check", () => {
  const dir = tmpDir();
  const key = loadOrCreateAuditKey(dir);
  const log = createAuditLog(dir, { signer: key.signer });
  log.record({ kind: "tool.call", tool: "a" });
  log.record({ kind: "tool.call", tool: "b" });

  // Attacker recomputes a valid hash chain for an edited entry (no key needed for
  // the hash) but cannot produce a valid signature over the new hash.
  const rows = lines(log.file);
  const forged = { ...rows[1], tool: "evil" } as Record<string, unknown>;
  const { prev } = { prev: rows[1].prev as string };
  const entry: Record<string, unknown> = { ...forged };
  delete entry.prev; delete entry.hash; delete entry.sig;
  forged.hash = chainHash(prev, entry);
  // leave the old (now-mismatched) signature in place
  rows[1] = forged;
  fs.writeFileSync(log.file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

  const res = verifyAuditChain(log.file, { publicKeys: { [key.keyId]: key.publicKeyPem } });
  assert.equal(res.ok, false);
  assert.match(res.reason ?? "", /signature invalid/);
});

test("chain resumes across restarts", () => {
  const dir = tmpDir();
  const key = loadOrCreateAuditKey(dir);
  createAuditLog(dir, { signer: key.signer }).record({ kind: "tool.call", tool: "a" });
  // Fresh instance, same dir — must continue the chain, not restart it.
  createAuditLog(dir, { signer: key.signer }).record({ kind: "tool.call", tool: "b" });

  const res = verifyAuditChain(log_file(dir), { publicKeys: { [key.keyId]: key.publicKeyPem } });
  assert.equal(res.ok, true);
  assert.equal(res.verified, 2);
});

test("legacy unchained prefix is tolerated, but holes inside are not", () => {
  const dir = tmpDir();
  const file = log_file(dir);
  fs.mkdirSync(dir, { recursive: true });
  // Two legacy lines with no chain fields.
  fs.writeFileSync(file, JSON.stringify({ ts: 1, kind: "tool.call", tool: "old" }) + "\n");
  fs.appendFileSync(file, JSON.stringify({ ts: 2, kind: "tool.call", tool: "old2" }) + "\n");
  // Then a chained region continuing from genesis.
  const key = loadOrCreateAuditKey(dir);
  createAuditLog(dir, { signer: key.signer }).record({ kind: "tool.call", tool: "new" });

  const res = verifyAuditChain(file, { publicKeys: { [key.keyId]: key.publicKeyPem } });
  assert.equal(res.ok, true);
  assert.equal(res.unprotectedPrefix, 2);
  assert.equal(res.verified, 1);

  // Splicing an unchained line into the chained region is rejected.
  const rows = lines(file);
  rows.push({ ts: 9, kind: "tool.call", tool: "injected" });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const res2 = verifyAuditChain(file, { publicKeys: { [key.keyId]: key.publicKeyPem } });
  assert.equal(res2.ok, false);
  assert.match(res2.reason ?? "", /unchained line inside chained region/);
});

function log_file(dir: string): string {
  return path.join(dir, "audit.jsonl");
}
