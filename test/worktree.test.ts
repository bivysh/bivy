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
    // A retry must preserve all classes of local work, including the index.
    fs.writeFileSync(path.join(readopt.path, "README.md"), "staged output\n");
    await exec("git", ["-C", readopt.path, "add", "README.md"]);
    fs.writeFileSync(path.join(readopt.path, "README.md"), "unstaged output\n");
    fs.writeFileSync(path.join(readopt.path, "untracked.txt"), "keep me\n");
    fs.writeFileSync(path.join(readopt.path, ".gitignore"), "ignored.txt\n");
    fs.writeFileSync(path.join(readopt.path, "ignored.txt"), "keep me too\n");
    const recovered = await createWorktree({ repoDir: dir, id: "issue-42", branch: readopt.branch });
    assert.equal(recovered.path, readopt.path);
    assert.equal(fs.readFileSync(path.join(recovered.path, "README.md"), "utf8"), "unstaged output\n");
    assert.equal((await exec("git", ["-C", recovered.path, "show", ":README.md"])).stdout, "staged output\n");
    assert.equal(fs.readFileSync(path.join(recovered.path, "untracked.txt"), "utf8"), "keep me\n");
    assert.equal(fs.readFileSync(path.join(recovered.path, "ignored.txt"), "utf8"), "keep me too\n");
    await assert.rejects(createWorktree({ repoDir: dir, id: "issue-42", branch: "bivy/wrong" }), /not on expected branch/);
    assert.equal(fs.readFileSync(path.join(recovered.path, "README.md"), "utf8"), "unstaged output\n");

    // Publish prior output, then recover on a fresh clone with no local branch.
    await exec("git", ["-C", recovered.path, "commit", "-qm", "prior output"]);
    const prior = (await exec("git", ["-C", recovered.path, "rev-parse", "HEAD"])).stdout;
    // A manually reaped checkout leaves stale Git metadata, but its committed
    // branch still needs to be recoverable without force-removing live data.
    fs.rmSync(recovered.path, { recursive: true, force: true });
    const reaped = await createWorktree({ repoDir: dir, id: "issue-42", branch: readopt.branch });
    assert.equal((await exec("git", ["-C", reaped.path, "rev-parse", "HEAD"])).stdout, prior);
    await removeWorktree(readopt.repoRoot, readopt.path);
    const remote = path.join(dir, ".bivy", "remote.git");
    const fresh = path.join(dir, ".bivy", "fresh");
    await exec("git", ["clone", "--bare", dir, remote]);
    await exec("git", ["clone", remote, fresh]);
    await assert.rejects(exec("git", ["-C", fresh, "show-ref", "--verify", `refs/heads/${readopt.branch}`]));
    const remoteRecovered = await createWorktree({ repoDir: fresh, id: "issue-42", branch: readopt.branch });
    assert.equal((await exec("git", ["-C", remoteRecovered.path, "rev-parse", "HEAD"])).stdout, prior);
    assert.equal(fs.readFileSync(path.join(remoteRecovered.path, "README.md"), "utf8"), "staged output\n");
    await removeWorktree(remoteRecovered.repoRoot, remoteRecovered.path);

    // An unregistered directory collision must fail without deleting files.
    const collision = path.join(dir, ".bivy", "worktrees", "collision");
    fs.mkdirSync(collision);
    fs.writeFileSync(path.join(collision, "keep.txt"), "unrelated data");
    await assert.rejects(createWorktree({ repoDir: dir, id: "collision", branch: readopt.branch }));
    assert.equal(fs.readFileSync(path.join(collision, "keep.txt"), "utf8"), "unrelated data");

    const fallback = await createWorktree({ repoDir: dir, id: "issue-99", branch: "bivy/issue-99", base: "bivy/does-not-exist" });
    assert.equal(fallback.branch, "bivy/issue-99");
    assert.ok(fs.existsSync(path.join(fallback.path, "README.md")), "invalid-base fallback has repo contents");
    await removeWorktree(fallback.repoRoot, fallback.path);

    console.log("worktree: ok (create, local/remote recovery, dirty work preservation, collision safety, invalid-base fallback)");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("worktree: FAILED\n", error);
  process.exit(1);
});
