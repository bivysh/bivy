import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { captureWorkspaceSnapshot, applyWorkspaceSnapshot } from "../src/session/fork-dirty.js";

function workspace(t: { after(fn: () => void): void }, repo = true): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-fork-snapshot-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  if (repo) execFileSync("git", ["-C", root, "init", "-q"]);
  return root;
}

function put(root: string, file: string, data: string | Buffer): void {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), data);
}

function names(root: string): string[] {
  return captureWorkspaceSnapshot(root).entries.map((entry) => entry.path).sort();
}

test("ignored dependencies do not count toward the cap; tracked ignored files survive", (t) => {
  const root = workspace(t);
  put(root, ".gitignore", "node_modules/\n*.log\n");
  put(root, "node_modules/large.bin", Buffer.alloc(4096));
  put(root, "debug.log", "ignored");
  put(root, "tracked.log", "keep tracked contents");
  execFileSync("git", ["-C", root, "add", "-f", "tracked.log"]);
  put(root, "source.ts", "source");
  put(root, ".bivy/state", "not portable");
  const snapshot = captureWorkspaceSnapshot(root, { maxBytes: 256 });
  assert.equal(snapshot.oversized, undefined);
  assert.deepEqual(snapshot.entries.map((entry) => entry.path).sort(), [".gitignore", "source.ts", "tracked.log"]);
  const dst = workspace(t, false);
  applyWorkspaceSnapshot(dst, snapshot);
  assert.equal(fs.readFileSync(path.join(dst, "tracked.log"), "utf8"), "keep tracked contents");
  assert.equal(fs.existsSync(path.join(dst, "node_modules")), false);
  assert.equal(captureWorkspaceSnapshot(root, { maxBytes: 1 }).oversized, true);
});

test("nested rules, negation, local excludes, and unusual filenames follow Git", (t) => {
  const root = workspace(t);
  put(root, ".gitignore", "*.tmp\n");
  put(root, ".git/info/exclude", "local-only\n");
  put(root, "local-only", "ignored");
  put(root, "sub/.gitignore", "!keep.tmp\ncache/\n");
  put(root, "sub/keep.tmp", "keep");
  put(root, "sub/drop.tmp", "drop");
  put(root, "sub/cache/large", "drop");
  put(root, "sub/spaces and\nnewline.txt", "keep");
  assert.deepEqual(names(root), [".gitignore", "sub/.gitignore", "sub/keep.tmp", "sub/spaces and\nnewline.txt"]);
  assert.deepEqual(names(path.join(root, "sub")), [".gitignore", "keep.tmp", "spaces and\nnewline.txt"]);
});

test("deleted tracked files are absent and symlinks are not followed", (t) => {
  const root = workspace(t);
  put(root, "deleted", "old");
  execFileSync("git", ["-C", root, "add", "deleted"]);
  fs.unlinkSync(path.join(root, "deleted"));
  fs.symlinkSync("/outside/workspace", path.join(root, "link"));
  const snapshot = captureWorkspaceSnapshot(root);
  assert.deepEqual(snapshot.entries, [{ path: "link", kind: "symlink", target: "/outside/workspace" }]);
});

test("plain directories still transfer files, excluding Bivy metadata", (t) => {
  const root = workspace(t, false);
  put(root, "sub/file", "contents");
  put(root, ".bivy/state", "private");
  assert.deepEqual(names(root), ["sub/file"]);
});

test("failed workspace inspection does not become an empty snapshot", () => {
  assert.throws(() => captureWorkspaceSnapshot("/nonexistent-bivy-fork-workspace"), /inspect|ENOENT/);
});
