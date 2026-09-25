// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveBranchBaseRef, parseGitHubRemote, parseRepo } from "../src/repo-workspace.js";

const exec = promisify(execFile);

// resolveBranchBaseRef backs the composer's branch pill (#466): a session
// clones the shared repo checkout, then must branch off a SPECIFIC remote
// branch instead of always the repo's default. Exercised against a real repo
// (a bare "origin" plus a clone, so `origin/<branch>` refs actually exist)
// rather than mocked, since the whole point is verifying real git ref
// resolution.
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-branch-base-"));
  try {
    const bare = path.join(root, "origin.git");
    const clone = path.join(root, "clone");
    await exec("git", ["init", "-q", "--bare", bare]);

    const seed = path.join(root, "seed");
    await exec("git", ["init", "-q", seed]);
    await exec("git", ["-C", seed, "config", "user.email", "t@t"]);
    await exec("git", ["-C", seed, "config", "user.name", "t"]);
    fs.writeFileSync(path.join(seed, "README.md"), "hi\n");
    await exec("git", ["-C", seed, "add", "-A"]);
    await exec("git", ["-C", seed, "commit", "-qm", "init"]);
    await exec("git", ["-C", seed, "branch", "-M", "main"]);
    await exec("git", ["-C", seed, "remote", "add", "origin", bare]);
    await exec("git", ["-C", seed, "push", "-q", "origin", "main"]);
    // A second remote branch, so we have something other than the default to
    // request.
    await exec("git", ["-C", seed, "checkout", "-qb", "feature/x"]);
    fs.writeFileSync(path.join(seed, "feature.txt"), "feature work\n");
    await exec("git", ["-C", seed, "add", "-A"]);
    await exec("git", ["-C", seed, "commit", "-qm", "feature work"]);
    await exec("git", ["-C", seed, "push", "-q", "origin", "feature/x"]);

    await exec("git", ["clone", "-q", bare, clone]);

    // Requesting the non-default remote branch resolves to its tracking ref.
    const ref = await resolveBranchBaseRef(clone, "feature/x");
    assert.equal(ref, "origin/feature/x");
    const { stdout } = await exec("git", ["-C", clone, "rev-parse", "--verify", ref]);
    assert.ok(stdout.trim(), "origin/feature/x resolves to a real commit");

    // The default branch resolves too — it's just another remote branch name.
    assert.equal(await resolveBranchBaseRef(clone, "main"), "origin/main");

    // A branch that doesn't exist on the remote throws a clear error instead
    // of silently falling back to the default.
    await assert.rejects(() => resolveBranchBaseRef(clone, "does-not-exist"), /was not found on the remote/);

    console.log("repo-workspace-branch: ok (resolves a requested remote branch, rejects an unknown one)");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("repo-workspace-branch: FAILED\n", error);
  process.exit(1);
});

// --- merged from repo-workspace.test.ts ---
{
  let failures = 0;
  function check(name: string, fn: () => void) {
    try {
      fn();
      console.log(`  ok  ${name}`);
    } catch (error) {
      failures += 1;
      console.error(`FAIL  ${name}\n      ${(error as Error).message}`);
    }
  }

  check("parses owner/repo", () => {
    assert.deepEqual(parseRepo("bivysh/bivy"), { owner: "bivysh", repo: "bivy", slug: "bivysh/bivy" });
  });

  check("tolerates https URL and .git", () => {
    assert.deepEqual(parseRepo("https://github.com/bivysh/bivy.git"), { owner: "bivysh", repo: "bivy", slug: "bivysh/bivy" });
  });

  check("tolerates ssh form", () => {
    assert.deepEqual(parseRepo("git@github.com:bivysh/bivy.git"), { owner: "bivysh", repo: "bivy", slug: "bivysh/bivy" });
  });

  check("rejects junk and injection attempts", () => {
    assert.equal(parseRepo("nope"), undefined);
    assert.equal(parseRepo("a/b/c"), undefined);
    assert.equal(parseRepo("owner/repo; rm -rf /"), undefined);
    assert.equal(parseRepo("owner/repo/../../evil"), undefined);
    assert.equal(parseRepo("https://evil.example/owner/repo"), undefined);
    assert.equal(parseRepo(""), undefined);
  });

  check("infers slug from GitHub remote URLs", () => {
    assert.deepEqual(parseGitHubRemote("https://github.com/bivysh/bivy.git"), { owner: "bivysh", repo: "bivy", slug: "bivysh/bivy" });
    assert.deepEqual(parseGitHubRemote("https://x-access-token:secret@github.com/bivysh/bivy.git"), { owner: "bivysh", repo: "bivy", slug: "bivysh/bivy" });
    assert.deepEqual(parseGitHubRemote("git@github.com:bivysh/bivy.git"), { owner: "bivysh", repo: "bivy", slug: "bivysh/bivy" });
    assert.equal(parseGitHubRemote("https://gitlab.com/bivysh/bivy.git"), undefined);
  });

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed`);
    process.exit(1);
  }
  console.log("\nrepo-workspace: all tests passed");
}
