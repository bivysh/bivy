// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
//
// Regression tests for concurrent-session isolation (the "sessions mixing" bug):
// a session must run in a per-session worktree, never directly in the shared
// clone root, and repo inference must not misclassify a busy checkout as
// "not a repo" (which is what let a session skip its worktree).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inferGitHubRepoFromWorkspace, isSharedCloneRoot } from "../src/repo-workspace.js";

const exec = promisify(execFile);

async function main() {
  // --- isSharedCloneRoot: shared clone root vs. isolated worktree -------------
  const reposRoot = "/tmp/repos";
  // `<reposRoot>/owner__repo` is the shared clone → must be flagged.
  assert.equal(isSharedCloneRoot("/tmp/repos/bivysh__bivy", reposRoot), true);
  assert.equal(isSharedCloneRoot("/tmp/repos/bivysh__bivy/", reposRoot), true);
  // A worktree lives DEEPER, so it is NOT the shared root.
  assert.equal(isSharedCloneRoot("/tmp/repos/bivysh__bivy/.bivy/worktrees/bivy-session-abc", reposRoot), false);
  // A user's own checkout outside reposRoot is unaffected (runs in place).
  assert.equal(isSharedCloneRoot("/home/me/project", reposRoot), false);
  assert.equal(isSharedCloneRoot(reposRoot, reposRoot), false);

  // --- inferGitHubRepoFromWorkspace: classification against real git ----------
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-iso-"));
  try {
    // (a) Not a git repo → definitive undefined (no throw).
    const notRepo = path.join(base, "plain");
    fs.mkdirSync(notRepo);
    assert.equal(await inferGitHubRepoFromWorkspace(notRepo), undefined, "non-repo → undefined");

    // (b) A git repo with NO origin remote → definitive undefined (no throw).
    const noOrigin = path.join(base, "no-origin");
    fs.mkdirSync(noOrigin);
    await exec("git", ["-C", noOrigin, "init", "-q"]);
    assert.equal(await inferGitHubRepoFromWorkspace(noOrigin), undefined, "no origin → undefined");

    // (c) A git repo with a GitHub origin → parsed slug.
    const gh = path.join(base, "gh");
    fs.mkdirSync(gh);
    await exec("git", ["-C", gh, "init", "-q"]);
    await exec("git", ["-C", gh, "remote", "add", "origin", "https://github.com/bivysh/bivy.git"]);
    assert.deepEqual(await inferGitHubRepoFromWorkspace(gh), { owner: "bivysh", repo: "bivy", slug: "bivysh/bivy" });

    // (d) A git repo whose origin is NOT GitHub → undefined (not a GitHub checkout).
    const gl = path.join(base, "gl");
    fs.mkdirSync(gl);
    await exec("git", ["-C", gl, "init", "-q"]);
    await exec("git", ["-C", gl, "remote", "add", "origin", "https://gitlab.com/bivysh/bivy.git"]);
    assert.equal(await inferGitHubRepoFromWorkspace(gl), undefined, "non-github origin → undefined");

    console.log("session-isolation: ok (shared-root predicate, infer classification)");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("session-isolation: FAILED\n", error);
  process.exit(1);
});
