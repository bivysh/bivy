// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { strict as assert } from "node:assert";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { EventLog, replayInlineImages, type LogRecord } from "../src/session/event-log.js";
import type { AttachmentRef } from "../src/session/attachment-store.js";

function ref(hash: string): AttachmentRef {
  return { hash, name: `${hash.slice(0, 6)}.png`, mimeType: "image/png", size: 10, kind: "image" };
}

function tmpLog(): { log: EventLog; dir: string; mk: () => EventLog } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-ii-"));
  const mk = () => new EventLog(dir, (id) => path.join(dir, `${encodeURIComponent(id)}.jsonl`));
  return { log: mk(), dir, mk };
}

test("appendInlineImage records a url→ref mapping and survives reload", () => {
  const { log, mk } = tmpLog();
  log.appendInlineImage("s1", { url: "https://x.test/a.png", ref: ref("a".repeat(64)) });
  log.flush("s1");

  const reloaded = mk().readInlineImages("s1");
  assert.deepEqual(reloaded, [["https://x.test/a.png", ref("a".repeat(64))]]);
});

test("readInlineImages is last-write-wins per URL", () => {
  // Order isn't semantically meaningful here (unlike replayOutboundAttachments,
  // which is positionally interleaved into the transcript) — this is a plain
  // url→ref lookup table, so only "the right ref per URL, one entry per URL"
  // matters. A re-resolved URL moves to the end (mirrors replayAttachments'
  // delete+set), which is fine precisely because nothing reads the order.
  const records: LogRecord[] = [
    { bivyKind: "inline-image", createdAt: 1, url: "https://x.test/a.png", ref: ref("1".repeat(64)) },
    { bivyKind: "inline-image", createdAt: 2, url: "https://x.test/b.png", ref: ref("2".repeat(64)) },
    { bivyKind: "inline-image", createdAt: 3, url: "https://x.test/a.png", ref: ref("3".repeat(64)) }, // updates a.png
  ];
  const folded = new Map(replayInlineImages(records));
  assert.equal(folded.size, 2);
  assert.equal(folded.get("https://x.test/a.png")?.hash, "3".repeat(64));
  assert.equal(folded.get("https://x.test/b.png")?.hash, "2".repeat(64));
});

test("appendInlineImage coalesces re-resolves of the same URL within a flush window", () => {
  const { log } = tmpLog();
  log.appendInlineImage("s1", { url: "https://x.test/a.png", ref: ref("1".repeat(64)) });
  log.appendInlineImage("s1", { url: "https://x.test/a.png", ref: ref("2".repeat(64)) });
  log.flush("s1");
  assert.deepEqual(log.readInlineImages("s1"), [["https://x.test/a.png", ref("2".repeat(64))]]);
});

test("inline-image records coexist with base/inbound/outbound-attachment records without disturbing them", () => {
  const { log } = tmpLog();
  log.appendBaseSnapshot("s1", [{ role: "assistant", content: "![chart](https://x.test/a.png)" }]);
  log.appendAttachments("s1", "hi", [{ hash: "b".repeat(64), name: "b.txt", mimeType: "text/plain", size: 1, kind: "file" }]);
  log.appendOutboundAttachment("s1", { afterMessageCount: 1, id: "o1", ref: ref("c".repeat(64)) });
  log.appendInlineImage("s1", { url: "https://x.test/a.png", ref: ref("d".repeat(64)) });
  log.flush("s1");

  assert.equal(log.readBase("s1").length, 1); // base untouched
  assert.equal(log.readAttachments("s1").length, 1); // inbound text→refs untouched
  assert.equal(log.readInlineImages("s1").length, 1); // inline images folded separately
  assert.equal(log.readInlineImages("s1")[0]![1].hash, "d".repeat(64));
  // Inline-image records are their own projection, not part of the extras
  // mergeTranscript folds in (mirrors how AttachmentLogEntry is excluded too).
  assert.equal(log.read("s1").length, 1); // only the outbound-attachment overlay
});

test("readInlineImages returns [] for a session with no inline-image records", () => {
  const { log } = tmpLog();
  log.appendBaseSnapshot("s1", [{ role: "user", content: "hi" }]);
  assert.deepEqual(log.readInlineImages("s1"), []);
});
