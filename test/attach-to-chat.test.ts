// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { strict as assert } from "node:assert";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { planAttachment, sniffMime, sanitizeAttachmentName, isAttachPlanError } from "../src/session/attach-to-chat.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

function tmpWorkspace(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bivy-attach-")));
}

test("plans an image inside the workspace (relative path), classifying by magic bytes", () => {
  const ws = tmpWorkspace();
  fs.writeFileSync(path.join(ws, "chart.bin"), PNG); // wrong extension on purpose
  const plan = planAttachment({ workspaceDir: ws, filePath: "chart.bin" });
  assert.equal(isAttachPlanError(plan), false);
  if (isAttachPlanError(plan)) return;
  assert.equal(plan.kind, "image");
  assert.equal(plan.mimeType, "image/png"); // sniffed, not from the .bin extension
  assert.equal(plan.name, "chart.bin");
  assert.deepEqual(plan.bytes, PNG);
});

test("classifies a non-image as a file and honors an explicit mime override", () => {
  const ws = tmpWorkspace();
  fs.writeFileSync(path.join(ws, "notes.txt"), "hello");
  const plan = planAttachment({ workspaceDir: ws, filePath: "notes.txt", mimeType: "text/markdown" });
  assert.equal(isAttachPlanError(plan), false);
  if (isAttachPlanError(plan)) return;
  assert.equal(plan.kind, "file");
  assert.equal(plan.mimeType, "text/markdown");
});

test("refuses a path outside the workspace", () => {
  const ws = tmpWorkspace();
  const outside = tmpWorkspace();
  fs.writeFileSync(path.join(outside, "secret"), "x");
  const plan = planAttachment({ workspaceDir: ws, filePath: path.join(outside, "secret") });
  assert.equal(isAttachPlanError(plan), true);
  assert.match((plan as { error: string }).error, /outside the session workspace/);
});

test("refuses a traversal that escapes via ..", () => {
  const ws = tmpWorkspace();
  const plan = planAttachment({ workspaceDir: ws, filePath: "../../../etc/hosts" });
  assert.equal(isAttachPlanError(plan), true);
});

test("refuses a symlink inside the workspace that points outside it", () => {
  const ws = tmpWorkspace();
  const outside = tmpWorkspace();
  const target = path.join(outside, "id_rsa");
  fs.writeFileSync(target, "PRIVATE KEY");
  const link = path.join(ws, "link");
  try {
    fs.symlinkSync(target, link);
  } catch {
    return; // symlinks unavailable on this platform — skip
  }
  const plan = planAttachment({ workspaceDir: ws, filePath: "link" });
  assert.equal(isAttachPlanError(plan), true, "symlink escaping the workspace must be refused");
});

test("enforces a size cap and refuses an empty file", () => {
  const ws = tmpWorkspace();
  fs.writeFileSync(path.join(ws, "big.bin"), Buffer.alloc(2048));
  const big = planAttachment({ workspaceDir: ws, filePath: "big.bin", maxBytes: 1024 });
  assert.equal(isAttachPlanError(big), true);
  assert.match((big as { error: string }).error, /too large/);

  fs.writeFileSync(path.join(ws, "empty.txt"), "");
  const empty = planAttachment({ workspaceDir: ws, filePath: "empty.txt" });
  assert.equal(isAttachPlanError(empty), true);
  assert.match((empty as { error: string }).error, /empty/);
});

test("reports a clear error for a missing file", () => {
  const ws = tmpWorkspace();
  const plan = planAttachment({ workspaceDir: ws, filePath: "nope.png" });
  assert.equal(isAttachPlanError(plan), true);
  assert.match((plan as { error: string }).error, /not found/i);
});

test("sniffMime recognizes common formats", () => {
  assert.equal(sniffMime(PNG), "image/png");
  assert.equal(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0x00])), "image/jpeg");
  assert.equal(sniffMime(Buffer.from("GIF89a...")), "image/gif");
  assert.equal(sniffMime(Buffer.from("%PDF-1.7")), "application/pdf");
  assert.equal(sniffMime(Buffer.from("plain text")), "");
});

test("sanitizeAttachmentName strips path components but keeps the extension", () => {
  assert.equal(sanitizeAttachmentName("../../etc/passwd.png"), "passwd.png");
  assert.equal(sanitizeAttachmentName("report.final.pdf"), "report.final.pdf");
  assert.equal(sanitizeAttachmentName(""), "attachment");
});
