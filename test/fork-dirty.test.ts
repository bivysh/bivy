import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { captureDirtyPatch, applyDirtyPatch } from "../src/session/fork-dirty.js";

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

/** A fresh clone has no committer identity — set one so `git commit` works. */
function configUser(dir: string) {
  git(dir, ["config", "user.email", "t@t"]);
  git(dir, ["config", "user.name", "t"]);
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

// --- diverged-base re-apply (fork bug #3): apply must degrade, never throw ----

// A multi-line repo so edits to different lines don't share hunk context.
function initMultiLineRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-dirty-ml-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@t"]);
  git(dir, ["config", "user.name", "t"]);
  fs.writeFileSync(path.join(dir, "f.txt"), "line1\nline2\nline3\nline4\nline5\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "base"]);
  return dir;
}

test("diverged base (non-conflicting lines) 3-way merges instead of throwing", () => {
  const src = initMultiLineRepo();
  // Uncommitted source edit on line 2.
  fs.writeFileSync(path.join(src, "f.txt"), "line1\nLINE2-EDIT\nline3\nline4\nline5\n");
  const dirty = captureDirtyPatch(src);

  // Destination cloned the same repo, then committed a change to line 5 — so a
  // strict `git apply` fails on context, but the base blob is present for 3-way.
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-dirty-diverge-"));
  git(dst, ["clone", "-q", src, "."]);
  configUser(dst);
  fs.writeFileSync(path.join(dst, "f.txt"), "line1\nline2\nline3\nline4\nLINE5-DEST\n");
  git(dst, ["commit", "-qam", "dest change"]);

  const res = applyDirtyPatch(dst, dirty);
  assert.equal(res.applied, true, "3-way merged the source edit onto the diverged base");
  const out = fs.readFileSync(path.join(dst, "f.txt"), "utf8");
  assert.ok(out.includes("LINE2-EDIT"), "source edit landed");
  assert.ok(out.includes("LINE5-DEST"), "destination commit preserved");
  assert.ok(!out.includes("<<<<<<<"), "no conflict markers when the edits don't overlap");
});

test("conflicting edit lands with markers + a warning, still does not throw", () => {
  const src = initMultiLineRepo();
  fs.writeFileSync(path.join(src, "f.txt"), "line1\nSOURCE-2\nline3\nline4\nline5\n");
  const dirty = captureDirtyPatch(src);

  const dst = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-dirty-conflict-"));
  git(dst, ["clone", "-q", src, "."]);
  configUser(dst);
  // Destination committed a DIFFERENT change to the SAME line → true conflict.
  fs.writeFileSync(path.join(dst, "f.txt"), "line1\nDEST-2\nline3\nline4\nline5\n");
  git(dst, ["commit", "-qam", "dest conflict"]);

  const res = applyDirtyPatch(dst, dirty);
  assert.equal(res.applied, true, "conflicting hunk still lands (with markers)");
  assert.equal(res.conflicted, true);
  assert.ok(res.warning && /conflict/i.test(res.warning), "surfaces a conflict warning");
  assert.ok(fs.readFileSync(path.join(dst, "f.txt"), "utf8").includes("<<<<<<<"), "conflict markers written");
});

test("un-appliable patch (no shared base blob) is a non-throwing warning, tree untouched", () => {
  const src = initMultiLineRepo();
  fs.writeFileSync(path.join(src, "f.txt"), "line1\nSOURCE-2\nline3\nline4\nline5\n");
  const dirty = captureDirtyPatch(src);

  // A brand-new, unrelated repo: it lacks the source's base blob, so 3-way can't
  // reconstruct the pre-image and nothing applies — but the fork must survive.
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-dirty-unrelated-"));
  git(dst, ["init", "-q"]);
  git(dst, ["config", "user.email", "t@t"]);
  git(dst, ["config", "user.name", "t"]);
  fs.writeFileSync(path.join(dst, "f.txt"), "utterly different content\n");
  git(dst, ["add", "-A"]);
  git(dst, ["commit", "-qm", "unrelated"]);

  const res = applyDirtyPatch(dst, dirty);
  assert.equal(res.applied, false, "nothing applied");
  assert.ok(res.warning && /left behind/i.test(res.warning), "surfaces a left-behind warning");
  assert.equal(fs.readFileSync(path.join(dst, "f.txt"), "utf8"), "utterly different content\n", "tree untouched");
});

console.log(`fork-dirty: all ${passed} tests passed`);
