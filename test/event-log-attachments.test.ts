// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { strict as assert } from "node:assert";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { EventLog, replayAttachments, type LogRecord } from "../src/session/event-log.js";
import type { AttachmentRef } from "../src/session/attachment-store.js";

function ref(hash: string, kind: "image" | "file" = "image"): AttachmentRef {
  return { hash, name: `${hash}.png`, mimeType: "image/png", size: 10, kind };
}

function tmpLog(): { log: EventLog; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-elog-"));
  return { log: new EventLog(dir, (id) => path.join(dir, `${encodeURIComponent(id)}.jsonl`)), dir };
}

test("appendAttachments persists refs keyed by text and survives a flush + reload", () => {
  const { log, dir } = tmpLog();
  log.appendAttachments("s1", "look at this [Image attachment: a.png]", [ref("a".repeat(64))]);
  log.flush("s1");
  // A fresh EventLog over the same dir reads the persisted record back.
  const reopened = new EventLog(dir, (id) => path.join(dir, `${encodeURIComponent(id)}.jsonl`));
  const got = reopened.readAttachments("s1");
  assert.equal(got.length, 1);
  assert.equal(got[0]![0], "look at this [Image attachment: a.png]");
  assert.equal(got[0]![1][0]!.hash, "a".repeat(64));
});

test("appendAttachments is a no-op without text or refs", () => {
  const { log } = tmpLog();
  log.appendAttachments("s1", "", [ref("a".repeat(64))]);
  log.appendAttachments("s1", "some text", []);
  assert.deepEqual(log.readAttachments("s1"), []);
});

test("replayAttachments is last-write-wins per text, preserving first-seen order", () => {
  const records: LogRecord[] = [
    { bivyKind: "attachment", createdAt: 1, text: "one", refs: [ref("1".repeat(64))] },
    { bivyKind: "attachment", createdAt: 2, text: "two", refs: [ref("2".repeat(64))] },
    { bivyKind: "attachment", createdAt: 3, text: "one", refs: [ref("3".repeat(64))] }, // re-keys "one"
  ];
  const folded = replayAttachments(records);
  // "one" moved to the end (newest) with its updated ref; "two" retained.
  assert.deepEqual(folded.map(([t]) => t), ["two", "one"]);
  assert.equal(folded.find(([t]) => t === "one")![1][0]!.hash, "3".repeat(64));
});

test("attachment records coexist with base/overlay records without disturbing them", () => {
  const { log } = tmpLog();
  log.appendBaseSnapshot("s1", [{ role: "user", content: "hi" }]);
  log.appendAttachments("s1", "hi", [ref("f".repeat(64), "file")]);
  log.flush("s1");
  // Base replay ignores the attachment record; attachment replay ignores base.
  assert.equal(log.readBase("s1").length, 1);
  assert.equal(log.readAttachments("s1").length, 1);
  assert.equal(log.readAttachments("s1")[0]![1][0]!.kind, "file");
});
