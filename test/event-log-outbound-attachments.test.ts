// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { strict as assert } from "node:assert";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { EventLog, replayOutboundAttachments, type LogRecord } from "../src/session/event-log.js";
import type { AttachmentRef } from "../src/session/attachment-store.js";

function ref(hash: string, kind: "image" | "file" = "image"): AttachmentRef {
  return { hash, name: `${hash.slice(0, 6)}.png`, mimeType: "image/png", size: 10, kind };
}

function tmpLog(): { log: EventLog; dir: string; mk: () => EventLog } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-oa-"));
  const mk = () => new EventLog(dir, (id) => path.join(dir, `${encodeURIComponent(id)}.jsonl`));
  return { log: mk(), dir, mk };
}

test("appendOutboundAttachment folds into a synthetic assistant message and survives reload", () => {
  const { log, mk } = tmpLog();
  log.appendOutboundAttachment("s1", { afterMessageCount: 2, id: "att1", ref: ref("a".repeat(64)), caption: "chart" });
  log.flush("s1");

  const extras = mk().read("s1"); // replayExtras (disk)
  assert.equal(extras.length, 1);
  const m = extras[0]!;
  assert.equal(m.role, "assistant");
  assert.equal(m.afterMessageCount, 2);
  const block = (m.content as Array<Record<string, unknown>>)[0]!;
  assert.equal(block.type, "bivy_attachment");
  assert.equal((block.ref as AttachmentRef).hash, "a".repeat(64));
  assert.equal(block.caption, "chart");
});

test("an explicit artifact:true marking survives a flush + fresh EventLog reload", () => {
  const { log, mk } = tmpLog();
  log.appendOutboundAttachment("s1", { afterMessageCount: 2, id: "att1", ref: ref("a".repeat(64)), caption: "coverage", artifact: true });
  log.flush("s1");

  const extras = mk().read("s1");
  const block = (extras[0]!.content as Array<Record<string, unknown>>)[0]!;
  assert.equal(block.artifact, true);
});

test("an ordinary (unmarked) attachment carries no artifact field at all — not even artifact:false", () => {
  const { log, dir } = tmpLog();
  log.appendOutboundAttachment("s1", { afterMessageCount: 1, id: "att1", ref: ref("a".repeat(64)) });
  log.flush("s1");

  const extras = log.read("s1");
  const block = (extras[0]!.content as Array<Record<string, unknown>>)[0]!;
  assert.equal("artifact" in block, false);
  // ...and the raw on-disk line matches, so an old client reading this log
  // sees byte-for-byte what it did before this field existed.
  const raw = fs.readFileSync(path.join(dir, `${encodeURIComponent("s1")}.jsonl`), "utf8");
  assert.equal(raw.includes("artifact"), false);
});

test("replayOutboundAttachments is last-write-wins per id, preserving first-seen order", () => {
  const records: LogRecord[] = [
    { bivyKind: "outbound-attachment", createdAt: 1, afterMessageCount: 1, id: "a", ref: ref("1".repeat(64)) },
    { bivyKind: "outbound-attachment", createdAt: 2, afterMessageCount: 1, id: "b", ref: ref("2".repeat(64)) },
    { bivyKind: "outbound-attachment", createdAt: 3, afterMessageCount: 1, id: "a", ref: ref("3".repeat(64)) }, // updates "a"
  ];
  const folded = replayOutboundAttachments(records);
  assert.deepEqual(folded.map((m) => m.id), ["a", "b"]);
  const first = (folded[0]!.content as Array<Record<string, unknown>>)[0]!;
  assert.equal((first.ref as AttachmentRef).hash, "3".repeat(64));
});

test("outbound attachments interleave into deriveHistory by position, next to base messages", () => {
  const { log } = tmpLog();
  log.appendBaseSnapshot("s1", [
    { role: "user", content: "make me a chart", timestamp: 100 },
    { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 200 },
  ]);
  log.appendOutboundAttachment("s1", { afterMessageCount: 2, id: "att1", ref: ref("f".repeat(64)), caption: "here" });

  const history = log.deriveHistory("s1");
  // Base (2) + the folded attachment message (1).
  assert.equal(history.length, 3);
  const last = history[history.length - 1] as Record<string, unknown>;
  const block = (last.content as Array<Record<string, unknown>>)[0]!;
  assert.equal(block.type, "bivy_attachment");
  assert.equal((block.ref as AttachmentRef).hash, "f".repeat(64));
});

test("outbound records coexist with base/inbound-attachment records without disturbing them", () => {
  const { log } = tmpLog();
  log.appendBaseSnapshot("s1", [{ role: "user", content: "hi" }]);
  log.appendAttachments("s1", "hi", [ref("b".repeat(64), "file")]); // inbound (user upload)
  log.appendOutboundAttachment("s1", { afterMessageCount: 1, id: "o1", ref: ref("c".repeat(64)) }); // outbound (agent)
  log.flush("s1");
  assert.equal(log.readBase("s1").length, 1); // base untouched
  assert.equal(log.readAttachments("s1").length, 1); // inbound text→refs untouched
  assert.equal(replayOutboundAttachments(log.entries("s1")).length, 1); // outbound folded separately
});
