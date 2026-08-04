import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { revertFile, confineToWorktree } from "../src/session/revert-file.js";

// C3d — safe per-file revert restores one file to its pre-turn content without
// touching the rest of the turn, and refuses to escape the worktree.

let failures = 0;
function check(name: string, fn: () => void) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (error) { failures++; console.error(`FAIL  ${name}\n      ${(error as Error).message}`); }
}

check("confineToWorktree rejects traversal and absolute escapes", () => {
  assert.equal(confineToWorktree("/repo", "../etc/passwd"), null);
  assert.equal(confineToWorktree("/repo", "/etc/passwd"), null);
  assert.equal(confineToWorktree("/repo", "src/a.ts"), path.resolve("/repo/src/a.ts"));
});

check("reverts a modified file back to its pre-turn content", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-revert-"));
  fs.writeFileSync(path.join(dir, "keep.txt"), "the agent changed this\n");
  const r = revertFile(dir, "keep.txt", "original\n");
  assert.equal(r.status, "reverted");
  assert.equal(fs.readFileSync(path.join(dir, "keep.txt"), "utf8"), "original\n");
  fs.rmSync(dir, { recursive: true, force: true });
});

check("recreates directories when reverting a nested file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-revert-"));
  const r = revertFile(dir, "src/deep/a.ts", "export const a = 1;\n");
  assert.equal(r.status, "reverted");
  assert.equal(fs.readFileSync(path.join(dir, "src/deep/a.ts"), "utf8"), "export const a = 1;\n");
  fs.rmSync(dir, { recursive: true, force: true });
});

check("removes a file the turn added (null pre-turn content)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-revert-"));
  fs.writeFileSync(path.join(dir, "new.txt"), "brand new\n");
  const r = revertFile(dir, "new.txt", null);
  assert.equal(r.status, "removed");
  assert.equal(fs.existsSync(path.join(dir, "new.txt")), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

check("refuses a path outside the worktree and writes nothing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-revert-"));
  const r = revertFile(dir, "../escape.txt", "pwned");
  assert.equal(r.ok, false);
  assert.equal(r.status, "rejected");
  assert.equal(fs.existsSync(path.join(dir, "../escape.txt")), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

if (failures > 0) { console.error(`\n${failures} revert-file test(s) failed`); process.exit(1); }
console.log("\nrevert-file: all tests passed");
