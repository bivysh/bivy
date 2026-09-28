import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClientProjection } from "../src/session/client-projection.js";
import { AttachmentStore } from "../src/session/attachment-store.js";
import { EventLog } from "../src/session/event-log.js";
import { foldTranscriptEvent, freshTranscriptDraft } from "../packages/core/src/transcript-event-fold.js";
import { renderHistory } from "../packages/core/src/store-render.js";

test("nested tool images are referenced, retained, rendered once, and never mutate native messages", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-projection-"));
  try {
    const store = new AttachmentStore(path.join(dir, "blobs"));
    const log = new EventLog(dir, id => path.join(dir, `${id}.jsonl`));
    const project = createClientProjection(store, log);
    const image = { type: "image", mimeType: "image/png", data: Buffer.alloc(400_000, 123).toString("base64") };
    const messages = [
      { role: "user", content: [{ type: "text", text: "look" }, image] },
      { role: "assistant", content: [{ type: "tool_use", id: "call", name: "read", input: {} }] },
      { role: "assistant", content: [{ type: "tool_result", tool_use_id: "call", content: { content: [image] } }] },
      { role: "toolResult", toolCallId: "call", content: [image] },
      { role: "assistant", content: [{ type: "text", text: "finished" }] },
    ];
    const before = JSON.stringify(messages);
    const projected = project("s", messages) as typeof messages;
    assert.equal(JSON.stringify(messages), before);
    assert.ok(JSON.stringify(projected).length < 3000);
    const refs = log.readInlineImages("s");
    assert.equal(refs.length, 1, "GC must retain the deduplicated blob");
    assert.equal(store.read(refs[0]![1].hash)?.length, 400_000);
    assert.deepEqual(project("s", messages), projected, "projection must give stable history cursor hashes");
    const rendered = renderHistory(projected);
    assert.equal(rendered.filter(entry => entry.attachments?.length).length, 2, "one user image and one tool image despite overlay duplication");
    assert.equal(rendered.at(-1)?.text, "finished");
    const live = foldTranscriptEvent({ transcript: [], draft: freshTranscriptDraft(), working: true, workingLabel: "Reading" },
      { type: "tool_result", toolCallId: "call", result: projected[3] }, 1);
    assert.equal(live.value.transcript.filter(entry => entry.attachments?.length).length, 1, "live images use the same lazy references as history");
    assert.equal(rendered.find(entry => entry.tool)?.tool?.status, "done");
    store.gc(new Set(refs.map(([, ref]) => ref.hash)), Date.now() + 40 * 86400_000);
    assert.ok(store.read(refs[0]![1].hash));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("storage failure leaves readable text and preserves the original image", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-projection-"));
  try {
    const store = new AttachmentStore(path.join(dir, "blobs"), { maxFileBytes: 1 });
    const log = new EventLog(dir, id => path.join(dir, `${id}.jsonl`));
    const native = [{ type: "text", text: "answer" }, { type: "image", data: "YWJj", mimeType: "image/png" }];
    const result = createClientProjection(store, log)("s", native);
    assert.match(JSON.stringify(result), /Image unavailable/);
    assert.match(JSON.stringify(result), /answer/);
    assert.equal(native[1]?.data, "YWJj");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
