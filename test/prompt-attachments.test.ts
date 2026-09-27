// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { attachmentsFrom, materializeAttachments } from "../src/session/prompt-attachments.js";
import { AttachmentStore } from "../src/session/attachment-store.js";
import { composite } from "../src/apps/annotate.js";
import { encodePng } from "../src/apps/rfb.js";

test("marked images retain their bytes for vision, workspace tools and chat history", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-prompt-attachments-"));
  try {
    const store = new AttachmentStore(path.join(dir, "store"));
    const png = composite(encodePng(100, 100, Buffer.alloc(30_000)), [{ tool: "pen", points: [[10, 10], [80, 80]] }], { scale: 1 });
    const { images, files } = attachmentsFrom([
      { kind: "image", name: "../../marked.png", mimeType: "image/png", data: png.toString("base64"), size: png.length },
      { kind: "file", name: "notes.txt", text: "Change the circled part" },
      { kind: "file", name: "data.bin", data: "AAEC" },
    ]);
    const { note, refs } = materializeAttachments(dir, files, store);
    const imagePath = path.join(dir, ".bivy-attachments", "marked.png");
    assert.ok(note.includes(`saved to ${imagePath}`));
    assert.deepEqual(fs.readFileSync(imagePath), png);
    assert.deepEqual(Buffer.from(images[0]!.data, "base64"), png);
    assert.deepEqual(refs.map(ref => ref.kind), ["image", "file", "file"]);
    assert.deepEqual(store.read(refs[0]!.hash), png);
    assert.equal(fs.readFileSync(path.join(dir, ".bivy-attachments", "notes.txt"), "utf8"), "Change the circled part");
    assert.deepEqual(fs.readFileSync(path.join(dir, ".bivy-attachments", "data.bin")), Buffer.from([0, 1, 2]));
    const again = materializeAttachments(dir, files, store);
    assert.ok(again.note.includes(path.join(dir, ".bivy-attachments", "marked-1.png")));
    assert.deepEqual(fs.readFileSync(imagePath), png);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("an unwritable workspace reports the failure while retaining the image in history and vision", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-prompt-attachments-"));
  try {
    const store = new AttachmentStore(path.join(dir, "store"));
    fs.writeFileSync(path.join(dir, ".bivy-attachments"), "blocked");
    const { images, files } = attachmentsFrom([{ kind: "image", name: "photo.png", data: "AAEC" }]);
    const result = materializeAttachments(dir, files, store);
    assert.match(result.note, /Image attachment: photo.png could not be saved/);
    assert.equal(images[0]!.data, "AAEC");
    assert.deepEqual(store.read(result.refs[0]!.hash), Buffer.from([0, 1, 2]));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
