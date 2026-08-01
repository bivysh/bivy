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
import { createWorktree } from "../src/worktree.js";

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

    // (e) Resume re-provisioning: a session's worktree is reaped (dir removed out
    // from under git), then re-provisioned on the SAME branch — the mechanic the
    // resume path relies on to restore isolation instead of falling to the root.
    const repo = path.join(base, "reap");
    fs.mkdirSync(repo);
    await exec("git", ["-C", repo, "init", "-q"]);
    await exec("git", ["-C", repo, "config", "user.email", "t@t"]);
    await exec("git", ["-C", repo, "config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "README.md"), "hi\n");
    await exec("git", ["-C", repo, "add", "-A"]);
    await exec("git", ["-C", repo, "commit", "-qm", "init"]);

    const branch = "bivy/session-deadbeef";
    const first = await createWorktree({ repoDir: repo, id: branch, branch });
    assert.ok(fs.existsSync(first.path), "worktree created");
    // Simulate a reap: delete the dir WITHOUT `git worktree remove` (worst case).
    fs.rmSync(first.path, { recursive: true, force: true });
    assert.ok(!fs.existsSync(first.path), "worktree dir reaped");
    // Prune the stale registration, then re-provision on the same branch.
    await exec("git", ["-C", repo, "worktree", "prune"]);
    const reprovisioned = await createWorktree({ repoDir: repo, id: branch, branch });
    assert.equal(reprovisioned.branch, branch, "re-provisioned on the same branch");
    assert.ok(fs.existsSync(path.join(reprovisioned.path, "README.md")), "re-provisioned worktree has repo contents");

    console.log("session-isolation: ok (shared-root predicate, infer classification, resume re-provision)");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("session-isolation: FAILED\n", error);
  process.exit(1);
});
