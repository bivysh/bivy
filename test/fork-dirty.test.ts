import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { captureDirtyPatch, captureTransportableDirtyPatch, applyDirtyPatch } from "../src/session/fork-dirty.js";

// Verifies fork's uncommitted-work transport: capture a working tree's tracked
// edits + untracked files as a patch, then re-apply it onto a fresh checkout at
// the same base commit and confirm the trees match. Also the size-cap fallback.

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

function git(dir: string, args: string[]) {
  execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
}

function initRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-dirty-src-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@t"]);
  git(dir, ["config", "user.name", "t"]);
  fs.writeFileSync(path.join(dir, "tracked.txt"), "base line\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "base"]);
  return dir;
}

test("capture + apply reproduces tracked edits and untracked files on a fresh checkout", () => {
  const src = initRepo();
  // Dirty the working tree: edit a tracked file + add an untracked one.
  fs.writeFileSync(path.join(src, "tracked.txt"), "base line\nan edit\n");
  fs.writeFileSync(path.join(src, "new-file.txt"), "brand new\n");
  fs.mkdirSync(path.join(src, "sub"), { recursive: true });
  fs.writeFileSync(path.join(src, "sub", "nested.txt"), "nested new\n");

  const dirty = captureDirtyPatch(src);
  assert.equal(dirty.pushedInstead, undefined);
  assert.ok(dirty.patch.includes("an edit"), "tracked edit is in the patch");
  assert.ok(dirty.patch.includes("brand new"), "untracked file is in the patch");

  // Fresh checkout at the same base commit (simulates the destination node).
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-dirty-dst-"));
  git(dst, ["clone", "-q", src, "."]);
  git(dst, ["checkout", "-q", "HEAD"]);
  // Reset to base (drop anything the clone might have carried) — clone only
  // brings committed state, so the working tree is clean here by construction.
  assert.equal(fs.readFileSync(path.join(dst, "tracked.txt"), "utf8"), "base line\n");

  applyDirtyPatch(dst, dirty);
  assert.equal(fs.readFileSync(path.join(dst, "tracked.txt"), "utf8"), "base line\nan edit\n", "tracked edit re-applied");
  assert.equal(fs.readFileSync(path.join(dst, "new-file.txt"), "utf8"), "brand new\n", "untracked file recreated");
  assert.equal(fs.readFileSync(path.join(dst, "sub", "nested.txt"), "utf8"), "nested new\n", "nested untracked file recreated");
});

test("a clean working tree captures an empty patch and applies as a no-op", () => {
  const src = initRepo();
  const dirty = captureDirtyPatch(src);
  assert.equal(dirty.patch.trim(), "");
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-dirty-clean-"));
  git(dst, ["clone", "-q", src, "."]);
  applyDirtyPatch(dst, dirty); // must not throw
  assert.equal(fs.readFileSync(path.join(dst, "tracked.txt"), "utf8"), "base line\n");
});

test("oversized working tree falls back to pushedInstead instead of inlining", () => {
  const src = initRepo();
  fs.writeFileSync(path.join(src, "big.bin"), Buffer.alloc(64 * 1024, 7));
  const dirty = captureDirtyPatch(src, { maxBytes: 1024 });
  assert.equal(dirty.pushedInstead, true);
  assert.equal(dirty.patch, "");
  // Apply is a no-op on the pushedInstead signal.
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-dirty-big-"));
  git(dst, ["clone", "-q", src, "."]);
  applyDirtyPatch(dst, dirty);
  assert.ok(!fs.existsSync(path.join(dst, "big.bin")), "no-op: destination reproduces from the pushed commit, not the patch");
});

test("transportable capture fails instead of silently dropping oversized dirty work", () => {
  const src = initRepo();
  fs.writeFileSync(path.join(src, "big.bin"), Buffer.alloc(64 * 1024, 7));
  assert.throws(
    () => captureTransportableDirtyPatch(src, { maxBytes: 1024 }),
    /too much uncommitted work/,
  );
});

console.log(`fork-dirty: all ${passed} tests passed`);
