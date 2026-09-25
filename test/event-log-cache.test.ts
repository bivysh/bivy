// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// The event log's in-memory cache is bounded, and whole-store sweeps (`scan`) read
// without populating it — so daemon memory tracks sessions in use, not all history.
import { strict as assert } from "node:assert";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { EventLog, type EventLogIssue } from "../src/session/event-log.js";
import type { AttachmentRef } from "../src/session/attachment-store.js";

const ATTACHMENT_KINDS = ["attachment", "outbound-attachment", "inline-image"] as const;

function ref(hash: string): AttachmentRef {
  return { hash, name: `${hash}.png`, mimeType: "image/png", size: 10, kind: "image" };
}

function setup(opts: { maxCachedBytes?: number; throttleMs?: number } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-elog-cache-"));
  const file = (id: string) => path.join(dir, `${id}.jsonl`);
  const issues: EventLogIssue[] = [];
  const open = () => new EventLog(dir, file, (t) => t, opts.throttleMs ?? 0, (issue) => issues.push(issue), opts.maxCachedBytes);
  return { dir, file, issues, open, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("scan returns only the wanted kinds and does not cache the log", (t) => {
  const s = setup();
  t.after(s.cleanup);
  const writer = s.open();
  writer.appendBaseSnapshot("s1", [{ role: "user", content: "hi" }]);
  writer.appendAttachments("s1", "hi", [ref("a".repeat(64))]);
  writer.appendInlineImage("s1", { url: "https://example.com/x.png", ref: ref("b".repeat(64)) });
  writer.flush("s1");

  const log = s.open();
  assert.deepEqual(log.scan("s1", ATTACHMENT_KINDS).map((r) => r.bivyKind), ["attachment", "inline-image"]);

  // Replace the file behind the log's back: a read that reflects the new content
  // proves scan left nothing cached.
  fs.writeFileSync(s.file("s1"), "");
  assert.deepEqual(log.readAttachments("s1"), []);
  assert.deepEqual(s.issues, []);
});

test("scan includes pending (unflushed) records", (t) => {
  const s = setup({ throttleMs: 60_000 });
  t.after(s.cleanup);
  const log = s.open();
  log.appendAttachments("s1", "one", [ref("a".repeat(64))]);
  log.flush("s1");
  log.appendAttachments("s1", "two", [ref("c".repeat(64))]); // held by the throttle
  assert.equal(log.health().pendingSessions, 1);
  assert.deepEqual(log.scan("s1", ATTACHMENT_KINDS).map((r) => (r as { text: string }).text), ["one", "two"]);
  log.drop("s1");
});

test("scan reports a torn attachment line so the attachment GC can fail closed", (t) => {
  const s = setup();
  t.after(s.cleanup);
  const good = JSON.stringify({ bivyKind: "attachment", createdAt: 1, text: "ok", refs: [ref("a".repeat(64))] });
  fs.writeFileSync(s.file("s1"), `${good}\n{"bivyKind":"attachment","createdAt":2,"text":"torn","refs":[{"ha`);
  const log = s.open();
  assert.equal(log.scan("s1", ATTACHMENT_KINDS).length, 1);
  assert.equal(s.issues.at(-1)?.operation, "parse");
  assert.equal(log.health().ok, false);
});

test("the cache evicts least-recently-used sessions past its byte cap", (t) => {
  const s = setup({ maxCachedBytes: 1 });
  t.after(s.cleanup);
  const writer = s.open();
  for (const id of ["s1", "s2"]) {
    writer.appendAttachments(id, id, [ref("a".repeat(64))]);
    writer.flush(id);
  }
  const log = s.open();
  assert.equal(log.readAttachments("s1").length, 1);
  assert.equal(log.readAttachments("s2").length, 1); // evicts s1; s2 stays even though it alone exceeds the cap
  fs.writeFileSync(s.file("s1"), "");
  fs.writeFileSync(s.file("s2"), "");
  assert.deepEqual(log.readAttachments("s1"), [], "s1 was evicted, so it re-read the file");
});

test("sessions within the cap stay cached", (t) => {
  const s = setup();
  t.after(s.cleanup);
  const log = s.open();
  log.appendAttachments("s1", "one", [ref("a".repeat(64))]);
  log.flush("s1");
  fs.writeFileSync(s.file("s1"), "");
  assert.equal(log.readAttachments("s1").length, 1);
});

test("flushing a session evicted mid-batch appends its records exactly once", (t) => {
  const s = setup({ maxCachedBytes: 1, throttleMs: 60_000 });
  t.after(s.cleanup);
  const log = s.open();
  log.appendAttachments("s1", "first", [ref("a".repeat(64))]);
  log.flush("s1");
  log.appendAttachments("s1", "second", [ref("b".repeat(64))]); // pending
  log.readAttachments("s2"); // evicts s1 while its batch is pending
  log.flush("s1");
  assert.deepEqual(log.readAttachments("s1").map(([text]) => text), ["first", "second"]);
  assert.equal(fs.readFileSync(s.file("s1"), "utf8").trim().split("\n").length, 2);
  assert.equal(log.entries("s1").length, 2, "no record is duplicated after the evicted session re-reads its file");
});
