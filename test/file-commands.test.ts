// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createFileCommands, listWorkspaceDir, readWorkspaceFile } from "../src/controllers/file-commands.js";

function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-files-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "a.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(dir, "src", "gone.ts"), "x\n");
  fs.writeFileSync(path.join(dir, "README.md"), "# hi\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  // Uncommitted work: one edit, one new file, one deletion.
  fs.writeFileSync(path.join(dir, "src", "a.ts"), "export const a = 2;\n");
  fs.writeFileSync(path.join(dir, "src", "new.ts"), "new\n");
  fs.rmSync(path.join(dir, "src", "gone.ts"));
  fs.writeFileSync(path.join(dir, "blob.bin"), Buffer.from([1, 0, 2, 3]));
  return dir;
}

test("a listing shows the agent's uncommitted work, including deleted files, and hides .git", async () => {
  const root = repo();
  const top = await listWorkspaceDir(root);
  assert.equal(top.git, true);
  assert.deepEqual(top.entries.map((e) => [e.name, e.type, e.status ?? e.changed ?? null]), [
    ["src", "dir", 3], ["blob.bin", "file", "added"], ["README.md", "file", null],
  ]);
  const src = await listWorkspaceDir(root, "src");
  assert.deepEqual(src.entries.map((e) => [e.path, e.status]), [["src/a.ts", "modified"], ["src/gone.ts", "deleted"], ["src/new.ts", "added"]]);
});

test("reading returns text, flags binary, and refuses paths outside the workspace", async () => {
  const root = repo();
  const file = await readWorkspaceFile(root, "src/a.ts");
  assert.equal(file.kind, "text");
  assert.equal(file.kind === "text" && file.content, "export const a = 2;\n");
  assert.equal(file.status, "modified");
  assert.equal((await readWorkspaceFile(root, "blob.bin")).kind, "binary");

  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-outside-"));
  fs.writeFileSync(path.join(outside, "secret"), "s");
  fs.symlinkSync(path.join(outside, "secret"), path.join(root, "link"));
  const replies: Record<string, unknown>[] = [];
  const commands = createFileCommands(() => root);
  const read = commands["files.read"] as (msg: Record<string, unknown>, ctx: { reply: (e: unknown) => void; broadcast: () => void }) => Promise<void>;
  for (const p of ["../secret", "/etc/passwd", "link", ".git/config"]) {
    await read({ kind: "files.read", sessionId: "s", path: p }, { reply: (e) => replies.push(e as Record<string, unknown>), broadcast: () => {} });
  }
  assert.deepEqual(replies.map((r) => r.type), ["files.read.error", "files.read.error", "files.read.error", "files.read.error"]);
  assert.ok(replies.every((r) => !String(r.error).includes(outside)));
});
