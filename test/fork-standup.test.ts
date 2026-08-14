import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveAdoptBaseRef, resolveForkBaseRef } from "../src/repo-workspace.js";
import { createWorktree } from "../src/worktree.js";

// Integration coverage for the cross-node fork stand-up path (fork bugs #2, #5):
//   - a fork ADOPTS its source branch from the pushed `origin/<branch>`, so
//     committed work travels (was: based off the destination's DEFAULT branch,
//     silently dropping every commit);
//   - the adopted worktree gets a UNIQUE directory, so standing a fork up never
//     reuses — or, via createWorktree's stale-dir cleanup, deletes — another
//     live session's worktree.
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

  await test("resolveForkBaseRef preserves an unpushed local branch", async () => {
    const { dest } = seedOriginAndClone();
    git(dest, ["checkout", "-q", "-b", "local-only"]);
    fs.writeFileSync(path.join(dest, "local.txt"), "local only\n");
    git(dest, ["add", "-A"]);
    git(dest, ["commit", "-qm", "local only commit"]);
    git(dest, ["checkout", "-q", "main"]);
    const base = await resolveForkBaseRef(dest, "local-only");
    assert.equal(base, "local-only");
    assert.match(execFileSync("git", ["-C", dest, "show", `${base}:local.txt`], { encoding: "utf8" }), /local only/);
  });

  await test("resolveForkBaseRef recovers origin and default fallbacks", async () => {
    const { dest } = seedOriginAndClone();
    assert.equal(await resolveForkBaseRef(dest, "feature"), "origin/feature");
    assert.equal(await resolveForkBaseRef(dest, "never-existed"), "origin/main");
  });

  await test("resolveForkBaseRef prefers the live source worktree HEAD", async () => {
    const { dest } = seedOriginAndClone();
    const src = await createWorktree({ repoDir: dest, id: "src-feature", branch: "bivy/src-feature", base: "origin/feature" });
    const expected = execFileSync("git", ["-C", src.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    assert.equal(await resolveForkBaseRef(dest, "missing-branch", src.path), expected);
  });

  await test("createWorktree falls back to HEAD for a stale base ref", async () => {
    const { dest } = seedOriginAndClone();
    const wt = await createWorktree({ repoDir: dest, id: "fork-invalid-base", branch: "bivy/fork-invalid-base", base: "bivy/does-not-exist" });
    assert.equal(wt.branch, "bivy/fork-invalid-base");
    assert.ok(fs.existsSync(path.join(wt.path, "base.txt")));
  });
}

run().then(() => {
  console.log(`fork-standup: all ${passed} tests passed`);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
