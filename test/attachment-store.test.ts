// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { strict as assert } from "node:assert";
import test from "node:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AttachmentStore, isValidAttachmentHash } from "../src/session/attachment-store.js";

function tmpStore(): { store: AttachmentStore; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-attach-"));
  return { store: new AttachmentStore(dir), dir };
}

test("put is content-addressed and returns a hash matching the bytes", () => {
  const { store } = tmpStore();
  const bytes = Buffer.from("hello world");
  const ref = store.put(bytes, { name: "a.txt", mimeType: "text/plain", kind: "file" });
  assert.equal(ref.hash, crypto.createHash("sha256").update(bytes).digest("hex"));
  assert.equal(ref.size, bytes.length);
  assert.equal(ref.name, "a.txt");
  assert.equal(ref.kind, "file");
  assert.ok(isValidAttachmentHash(ref.hash));
});

test("identical bytes dedupe to one blob; first name/mime wins in the sidecar", () => {
  const { store, dir } = tmpStore();
  const bytes = Buffer.from([1, 2, 3, 4, 5]);
  const first = store.put(bytes, { name: "first.bin", mimeType: "application/octet-stream", kind: "file" });
  const second = store.put(bytes, { name: "second.bin", mimeType: "image/png", kind: "image" });
  assert.equal(first.hash, second.hash);
  // Only one blob + one sidecar exist for these bytes.
  const shard = path.join(dir, first.hash.slice(0, 2), first.hash.slice(2, 4));
  const entries = fs.readdirSync(shard).sort();
  assert.deepEqual(entries, [first.hash, `${first.hash}.json`]);
  // The sidecar remembers the FIRST put's metadata.
  const meta = store.readMeta(first.hash);
  assert.equal(meta?.name, "first.bin");
  assert.equal(meta?.mimeType, "application/octet-stream");
  assert.equal(typeof meta?.createdAt, "number");
});

test("read / getPath round-trip the stored bytes", () => {
  const { store } = tmpStore();
  const bytes = crypto.randomBytes(2048);
  const ref = store.put(bytes, { name: "img.png", mimeType: "image/png", kind: "image" });
  assert.deepEqual(store.read(ref.hash), bytes);
  assert.ok(store.getPath(ref.hash));
  assert.deepEqual(fs.readFileSync(store.getPath(ref.hash)!), bytes);
});

test("put enforces the node-side file limit and leaves no partial temp files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-attach-"));
  const store = new AttachmentStore(dir, { maxFileBytes: 4 });
  assert.throws(() => store.put(Buffer.from("12345"), { name: "large.txt", mimeType: "text/plain", kind: "file" }), /exceeds/);
  assert.deepEqual(fs.readdirSync(dir), []);
  const ref = store.put(Buffer.from("1234"), { name: "ok.txt", mimeType: "text/plain", kind: "file" });
  const shard = path.dirname(store.getPath(ref.hash)!);
  assert.ok(fs.readdirSync(shard).every((name) => !name.includes(".tmp-")));
});

test("gc removes only unreferenced blobs and reports referenced over-cap data", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-attach-"));
  const writer = new AttachmentStore(dir, { maxStoreBytes: 20, retentionMs: 0 });
  const keep = writer.put(Buffer.from("123456"), { name: "keep.txt", mimeType: "text/plain", kind: "file" });
  const orphan = writer.put(Buffer.from("abcdef"), { name: "orphan.txt", mimeType: "text/plain", kind: "file" });
  // Simulate lowering the configured cap below retained history: GC must report
  // the overage, not destroy the referenced blob.
  const store = new AttachmentStore(dir, { maxStoreBytes: 5, retentionMs: 0 });
  const stats = store.gc(new Set([keep.hash]), Date.now() + 1);
  assert.ok(store.getPath(keep.hash), "a transcript-referenced blob is retained");
  assert.equal(store.getPath(orphan.hash), null, "an unreferenced blob is collected");
  assert.equal(stats.bytes, 6);
  assert.equal(stats.removedBlobs, 1);
  assert.equal(stats.overCapBytes, 1);
});

test("new unique blobs are rejected at the global admission cap, while dedupe remains allowed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-attach-"));
  const store = new AttachmentStore(dir, { maxStoreBytes: 6 });
  const keep = store.put(Buffer.from("123456"), { name: "keep.txt", mimeType: "text/plain", kind: "file" });
  assert.equal(store.put(Buffer.from("123456"), { name: "dedupe.txt", mimeType: "text/plain", kind: "file" }).hash, keep.hash);
  assert.throws(() => store.put(Buffer.from("x"), { name: "extra.txt", mimeType: "text/plain", kind: "file" }), /capacity/);
});

test("unknown or malformed hashes return null instead of touching disk", () => {
  const { store } = tmpStore();
  assert.equal(store.read("deadbeef"), null); // too short
  assert.equal(store.getPath("../../etc/passwd"), null); // traversal attempt
  assert.equal(store.readMeta("z".repeat(64)), null); // non-hex
  assert.equal(store.getPath("a".repeat(64)), null); // valid shape, not stored
  assert.equal(isValidAttachmentHash("a".repeat(64)), true);
  assert.equal(isValidAttachmentHash("A".repeat(64)), false); // uppercase rejected
  assert.equal(isValidAttachmentHash("xyz"), false);
});
