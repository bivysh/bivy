import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isReusableCheckout, fetchOrigin } from "../src/repo-workspace.js";

const exec = promisify(execFile);

// cloneOrUpdateRepo reuses an existing checkout only when isReusableCheckout is
// true. The regression this guards: a present-but-broken `.git` used to be
// reused, so every later "new session on this repo" failed with "Not a git
// repository" in createWorktree. A broken/absent checkout must NOT be reused
// (so it gets wiped and re-cloned instead).
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-clone-"));
  try {
    // A real checkout is reusable.
    const good = path.join(root, "owner__good");
    await exec("git", ["-C", root, "init", "-q", "owner__good"]);
    await exec("git", ["-C", good, "config", "user.email", "t@t"]);
    await exec("git", ["-C", good, "config", "user.name", "t"]);
    fs.writeFileSync(path.join(good, "README.md"), "hi\n");
    await exec("git", ["-C", good, "add", "-A"]);
    await exec("git", ["-C", good, "commit", "-qm", "init"]);
    assert.equal(await isReusableCheckout(good), true, "valid checkout is reusable");

    // A directory with a bogus `.git` (interrupted/corrupt clone) is NOT.
    const broken = path.join(root, "owner__broken");
    fs.mkdirSync(path.join(broken, ".git"), { recursive: true });
    fs.writeFileSync(path.join(broken, "README.md"), "partial\n");
    assert.equal(await isReusableCheckout(broken), false, "broken .git is not reusable");

    // A directory with no `.git` at all is NOT reusable.
    const bare = path.join(root, "owner__bare");
    fs.mkdirSync(bare, { recursive: true });
    assert.equal(await isReusableCheckout(bare), false, "no .git is not reusable");

    // A path that does not exist is NOT reusable.
    assert.equal(await isReusableCheckout(path.join(root, "owner__missing")), false, "missing path is not reusable");

    // fetchOrigin is best-effort: it must never throw, even when origin is
    // missing/unreachable or the dir isn't a repo — the caller then branches
    // off whatever refs already exist.
    await fetchOrigin(good); // real repo, no reachable origin configured
    await fetchOrigin(bare); // not a git repo at all
    console.log("repo-clone-selfheal: ok (valid reused, broken/absent rebuilt, fetchOrigin best-effort)");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("repo-clone-selfheal: FAILED\n", error);
  process.exit(1);
});
