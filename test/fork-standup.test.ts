import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveAdoptBaseRef, resolveForkBaseRef } from "../src/repo-workspace.js";
import { createWorktree } from "../src/worktree.js";

// Integration coverage for the fork stand-up path (fork bugs #2, #5 + fresh-base fallback):
//   - a fork ADOPTS its source branch from the pushed `origin/<branch>`, so
//     committed work travels (was: based off the destination's DEFAULT branch,
//     silently dropping every commit);
//   - the adopted worktree gets a UNIQUE directory, so standing a fork up never
//     reuses — or, via createWorktree's stale-dir cleanup, deletes — another
//     live session's worktree;
//   - a same-node "fresh" fork resolves its base through source-worktree HEAD →
//     local branch → origin/<branch> → default, so a missing local ref no longer
//     hard-fails with `fatal: invalid reference`.
// These exercise real git repositories the way standUpFork does on a fresh clone.

let passed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

function git(dir: string, args: string[]) {
  execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
}
function configUser(dir: string) {
  git(dir, ["config", "user.email", "t@t"]);
  git(dir, ["config", "user.name", "t"]);
}

/**
 * Build a bare "origin" seeded with `main` plus a `feature` branch that carries a
 * commit NOT on main, and return a fresh clone of it (a stand-in for the fork
 * destination's re-clone). `feature.txt` only exists on `feature`.
 */
function seedOriginAndClone(): { origin: string; dest: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-fork-standup-"));
  const origin = path.join(root, "origin.git");
  git(root, ["init", "--bare", "-q", "origin.git"]);

  const work = path.join(root, "work");
  git(root, ["clone", "-q", origin, "work"]);
  configUser(work);
  // Force a deterministic default branch name across git versions.
  git(work, ["checkout", "-q", "-B", "main"]);
  fs.writeFileSync(path.join(work, "base.txt"), "base\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "-qm", "base on main"]);
  git(work, ["push", "-q", "-u", "origin", "main"]);
  // A feature branch with committed work that main does not have.
  git(work, ["checkout", "-q", "-b", "feature"]);
  fs.writeFileSync(path.join(work, "feature.txt"), "committed feature work\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "-qm", "feature commit"]);
  git(work, ["push", "-q", "-u", "origin", "feature"]);
  // Record the remote default so resolveDefaultBaseRef can read origin/HEAD.
  git(origin, ["symbolic-ref", "HEAD", "refs/heads/main"]);

  const dest = path.join(root, "dest");
  git(root, ["clone", "-q", origin, "dest"]);
  configUser(dest);
  return { origin, dest };
}

async function run() {
  await test("resolveAdoptBaseRef prefers the pushed origin/<branch> (carries committed work)", async () => {
    const { dest } = seedOriginAndClone();
    const base = await resolveAdoptBaseRef(dest, "feature");
    assert.equal(base, "origin/feature", "adopts the source branch from origin, not the default");
    // The resolved base must actually contain the source's committed file.
    const show = execFileSync("git", ["-C", dest, "show", `${base}:feature.txt`], { encoding: "utf8" });
    assert.match(show, /committed feature work/, "origin/feature carries the source commit");
  });

  await test("resolveAdoptBaseRef falls back to the default branch for an unpushed source branch", async () => {
    const { dest } = seedOriginAndClone();
    const base = await resolveAdoptBaseRef(dest, "never-pushed");
    assert.equal(base, "origin/main", "degrades to the repo default rather than throwing");
  });

  await test("resolveAdoptBaseRef fetches, so a branch pushed after the clone is still found", async () => {
    const { origin, dest } = seedOriginAndClone();
    // Push a NEW branch to origin AFTER dest was cloned; only a fetch reveals it.
    const work2 = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-fork-standup-w2-"));
    git(path.dirname(work2), ["clone", "-q", origin, path.basename(work2)]);
    configUser(work2);
    git(work2, ["checkout", "-q", "-b", "late"]);
    fs.writeFileSync(path.join(work2, "late.txt"), "late\n");
    git(work2, ["add", "-A"]);
    git(work2, ["commit", "-qm", "late commit"]);
    git(work2, ["push", "-q", "-u", "origin", "late"]);

    const base = await resolveAdoptBaseRef(dest, "late");
    assert.equal(base, "origin/late", "the fetch inside resolveAdoptBaseRef surfaced the new branch");
  });

  await test("adopt worktree based on origin/<branch> reproduces the source's committed work", async () => {
    const { dest } = seedOriginAndClone();
    const base = await resolveAdoptBaseRef(dest, "feature");
    const wt = await createWorktree({ repoDir: dest, id: `feature-${"a1b2"}`, branch: "feature", base });
    assert.equal(wt.branch, "feature");
    assert.equal(fs.readFileSync(path.join(wt.path, "feature.txt"), "utf8"), "committed feature work\n", "committed work landed in the fork worktree");
  });

  await test("a unique adopt dir never deletes another session's live worktree", async () => {
    const { dest } = seedOriginAndClone();
    const base = await resolveAdoptBaseRef(dest, "feature");
    // First fork adopts `feature` into its own uniquely-named dir.
    const first = await createWorktree({ repoDir: dest, id: "feature-1111", branch: "feature", base });
    assert.ok(fs.existsSync(path.join(first.path, "feature.txt")));

    // A second stand-up of the SAME branch uses a DIFFERENT dir id. git forbids
    // two worktrees on one branch, so this fails — but crucially it must NOT wipe
    // the first (live) worktree the way a shared dir + rmSync would have.
    await assert.rejects(
      createWorktree({ repoDir: dest, id: "feature-2222", branch: "feature", base }),
      "git refuses a second worktree on the same branch",
    );
    assert.ok(fs.existsSync(path.join(first.path, "feature.txt")), "the first worktree survived the second attempt");
  });

  await test("resolveForkBaseRef prefers the local branch (unpushed commits travel)", async () => {
    const { dest } = seedOriginAndClone();
    // Create a local-only branch with a commit origin does not have.
    git(dest, ["checkout", "-q", "-b", "local-only"]);
    fs.writeFileSync(path.join(dest, "local.txt"), "local only\n");
    git(dest, ["add", "-A"]);
    git(dest, ["commit", "-qm", "local only commit"]);
    git(dest, ["checkout", "-q", "main"]);

    const base = await resolveForkBaseRef(dest, "local-only");
    assert.equal(base, "local-only", "uses the local branch name, not origin or default");
    const show = execFileSync("git", ["-C", dest, "show", `${base}:local.txt`], { encoding: "utf8" });
    assert.match(show, /local only/, "local-only commit is reachable from the resolved base");
  });

  await test("resolveForkBaseRef falls back to origin/<branch> when the local ref is gone", async () => {
    const { dest } = seedOriginAndClone();
    // feature exists on origin (seeded) but not as a local branch after a bare clone
    // checkout of main — which is the "re-cloned workspace lost local branches" case.
    const base = await resolveForkBaseRef(dest, "feature");
    assert.equal(base, "origin/feature", "recovers the source branch from origin after local loss");
  });

  await test("resolveForkBaseRef falls back to the default branch when nothing matches", async () => {
    const { dest } = seedOriginAndClone();
    const base = await resolveForkBaseRef(dest, "bivy/never-existed-branch");
    assert.equal(base, "origin/main", "degrades to the repo default rather than throwing");
  });

  await test("resolveForkBaseRef prefers a live source worktree HEAD over a missing branch name", async () => {
    const { dest } = seedOriginAndClone();
    // Stand up a worktree on feature, then DELETE the branch ref's only local
    // checkout name from the caller's perspective by resolving via the worktree
    // path directly — the tip SHA must win over a bogus branch name.
    const src = await createWorktree({
      repoDir: dest,
      id: "src-feature",
      branch: "bivy/src-feature",
      base: "origin/feature",
    });
    const expectedSha = execFileSync("git", ["-C", src.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const base = await resolveForkBaseRef(dest, "bivy/totally-missing", src.path);
    assert.equal(base, expectedSha, "source worktree HEAD is the most accurate same-node tip");
  });

  await test("fresh fork worktree still stands up when the source branch ref is missing", async () => {
    const { dest } = seedOriginAndClone();
    // Mirrors standUpFork's fresh path after resolveForkBaseRef: cut a new
    // fork branch from the resolved base even though the named source branch
    // does not exist locally or on origin.
    const missing = "bivy/bivy-automation-templates-exploration-eb6d62";
    const base = await resolveForkBaseRef(dest, missing);
    const forkBranch = `${missing}-fork-f31cbe`;
    const wt = await createWorktree({ repoDir: dest, id: forkBranch, branch: forkBranch, base });
    assert.equal(wt.branch, forkBranch);
    assert.ok(fs.existsSync(path.join(wt.path, "base.txt")), "fork worktree has repo contents from the fallback base");
  });

  await test("createWorktree falls back to HEAD when given an invalid base ref", async () => {
    const { dest } = seedOriginAndClone();
    // Defense in depth: even if a caller skips resolveForkBaseRef and passes a
    // raw missing branch name (the pre-fix standUpFork behaviour), the worktree
    // still stands up instead of throwing `fatal: invalid reference`.
    const wt = await createWorktree({
      repoDir: dest,
      id: "fork-invalid-base",
      branch: "bivy/fork-invalid-base",
      base: "bivy/does-not-exist-anywhere",
    });
    assert.equal(wt.branch, "bivy/fork-invalid-base");
    assert.ok(fs.existsSync(path.join(wt.path, "base.txt")), "invalid-base fallback still checked out the repo");
  });
}

run().then(() => {
  console.log(`fork-standup: all ${passed} tests passed`);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
