// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MAX_DOWNLOAD_BYTES, createFileCommands, downloadWorkspaceFile, listWorkspaceDir, readWorkspaceFile, searchWorkspace } from "../src/controllers/file-commands.js";

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

test("a download carries any file whole, within the workspace and the size ceiling", async () => {
  const root = repo();
  const bin = await downloadWorkspaceFile(root, "blob.bin");
  assert.deepEqual([...Buffer.from(bin.data, "base64")], [1, 0, 2, 3]);
  fs.writeFileSync(path.join(root, "big.txt"), Buffer.alloc(MAX_DOWNLOAD_BYTES + 1, 97));
  await assert.rejects(downloadWorkspaceFile(root, "big.txt"), /can't be downloaded/);
  await assert.rejects(downloadWorkspaceFile(root, "../outside"));
});

test("search finds files and folders by name, uncommitted ones too, and skips ignored and hidden paths", async () => {
  const root = repo();
  fs.writeFileSync(path.join(root, ".gitignore"), "dist/\n");
  fs.mkdirSync(path.join(root, "dist"));
  fs.writeFileSync(path.join(root, "dist", "new.js"), "x\n");
  const found = await searchWorkspace(root, "new");
  assert.deepEqual(found.entries, [{ path: "src/new.ts", type: "file" }], "untracked counts, ignored does not");
  const top = (await searchWorkspace(root, "")).entries.map((e) => e.path);
  assert.deepEqual(top.slice(0, 4).sort(), [".gitignore", "README.md", "blob.bin", "src"], "an empty query lists the top first");
  assert.deepEqual((await searchWorkspace(root, "src/")).entries.map((e) => e.path), ["src/a.ts", "src/new.ts"], "a folder path lists what is inside it");
  assert.equal((await searchWorkspace(root, "config")).entries.length, 0, ".git is never searched");

  // Not a checkout: a walk that skips node_modules and never follows a link out.
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-plain-"));
  fs.mkdirSync(path.join(plain, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(plain, "node_modules", "pkg", "notes.md"), "x\n");
  fs.mkdirSync(path.join(plain, "docs"));
  fs.writeFileSync(path.join(plain, "docs", "notes.md"), "x\n");
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-outside-"));
  fs.writeFileSync(path.join(outside, "notes-secret.md"), "s");
  fs.symlinkSync(outside, path.join(plain, "out"));
  assert.deepEqual((await searchWorkspace(plain, "notes")).entries, [{ path: "docs/notes.md", type: "file" }]);
});
