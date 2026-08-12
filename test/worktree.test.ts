import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { branchSlug, gitRepoRoot, createWorktree, removeWorktree } from "../src/worktree.js";

const exec = promisify(execFile);

async function main() {
  // Pure slug checks (no git needed).
  assert.equal(branchSlug("Fix the Login Bug!"), "fix-the-login-bug");
  assert.equal(branchSlug("issue/12: thing"), "issue-12-thing");
  assert.equal(branchSlug(""), "task");

  // Real git worktree in a temp repo.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-wt-"));
  try {
    await exec("git", ["-C", dir, "init", "-q"]);
    await exec("git", ["-C", dir, "config", "user.email", "t@t"]);
    await exec("git", ["-C", dir, "config", "user.name", "t"]);
    fs.writeFileSync(path.join(dir, "README.md"), "hi\n");
    await exec("git", ["-C", dir, "add", "-A"]);
    await exec("git", ["-C", dir, "commit", "-qm", "init"]);

    assert.equal(await gitRepoRoot(dir), fs.realpathSync(dir));

    const wt = await createWorktree({ repoDir: dir, id: "issue-42" });
    assert.ok(fs.existsSync(path.join(wt.path, "README.md")), "worktree has repo contents");
    assert.equal(wt.branch, "bivy/issue-42");

    // The branch exists and the worktree is registered.
    const { stdout } = await exec("git", ["-C", dir, "worktree", "list"]);
    assert.ok(stdout.includes(wt.path), "worktree is listed");

    // .bivy/ is excluded so it won't pollute git status.
    const exclude = fs.readFileSync(path.join(dir, ".git", "info", "exclude"), "utf8");
    assert.ok(exclude.includes(".bivy/"), ".bivy/ is excluded");

    await removeWorktree(wt.repoRoot, wt.path);
    const after = await exec("git", ["-C", dir, "worktree", "list"]);
    assert.ok(!after.stdout.includes(wt.path), "worktree removed");

    // Re-creating a worktree on a branch that already exists (e.g. a GitHub-issue
    // follow-up after the session closed) must ADOPT the branch, not hard-fail —
    // the hard failure is what silently dropped follow-up work items.
    const readopt = await createWorktree({ repoDir: dir, id: "issue-42", branch: "bivy/issue-42" });
    assert.equal(readopt.branch, "bivy/issue-42");
    assert.ok(fs.existsSync(path.join(readopt.path, "README.md")), "re-adopted worktree has repo contents");
    await removeWorktree(readopt.repoRoot, readopt.path);

    const fallback = await createWorktree({ repoDir: dir, id: "issue-99", branch: "bivy/issue-99", base: "bivy/does-not-exist" });
    assert.equal(fallback.branch, "bivy/issue-99");
    assert.ok(fs.existsSync(path.join(fallback.path, "README.md")), "invalid-base fallback has repo contents");
    await removeWorktree(fallback.repoRoot, fallback.path);

    console.log("worktree: ok (slug, create, list, exclude, remove, re-adopt, invalid-base fallback)");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("worktree: FAILED\n", error);
  process.exit(1);
});
