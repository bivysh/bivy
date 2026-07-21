import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CheckpointStore, NotAGitRepoError } from "../src/harness/checkpoint.js";

let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${(error as Error).stack ?? (error as Error).message}`);
  }
}

function git(dir: string, ...args: string[]) {
  execFileSync("git", ["-C", dir, ...args], {
    stdio: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "t@t.local",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "t@t.local",
    },
  });
}

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-cp-"));
  git(dir, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, ".gitignore"), "ignored/\n");
  fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "initial");
  return dir;
}

async function main() {
  await check("open() rejects a non-git dir with NotAGitRepoError", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-nogit-"));
    await assert.rejects(() => CheckpointStore.open(dir, "s1"), NotAGitRepoError);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await check("snapshot → mutate → changesSince reports added + modified", async () => {
    const dir = makeRepo();
    const store = await CheckpointStore.open(dir, "s1");
    const base = await store.snapshot("before turn");

    // Agent edits an existing file and creates a brand-new (untracked) one.
    fs.writeFileSync(path.join(dir, "a.txt"), "hello world\n");
    fs.writeFileSync(path.join(dir, "b.txt"), "new file\n");

    const changes = await store.changesSince(base);
    const byPath = Object.fromEntries(changes.map((c) => [c.path, c]));
    assert.equal(changes.length, 2, `expected 2 changes, got ${changes.map((c) => c.path).join(",")}`);
    assert.equal(byPath["a.txt"].status, "modified");
    assert.equal(byPath["a.txt"].oldText, "hello\n");
    assert.equal(byPath["a.txt"].newText, "hello world\n");
    assert.equal(byPath["b.txt"].status, "added");
    assert.equal(byPath["b.txt"].oldText, "");
    assert.equal(byPath["b.txt"].newText, "new file\n");
    // Authoritative numstat counts: a.txt swapped one line (1 add / 1 del); the
    // new b.txt is a single added line (0 del). These drive the card's +/- stat.
    assert.equal(byPath["a.txt"].added, 1);
    assert.equal(byPath["a.txt"].removed, 1);
    assert.equal(byPath["b.txt"].added, 1);
    assert.equal(byPath["b.txt"].removed, 0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await check("rewindTo restores modified files and removes added ones", async () => {
    const dir = makeRepo();
    const store = await CheckpointStore.open(dir, "s1");
    const base = await store.snapshot("before turn");

    fs.writeFileSync(path.join(dir, "a.txt"), "corrupted by agent\n");
    fs.writeFileSync(path.join(dir, "b.txt"), "junk the agent made\n");
    fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
    fs.writeFileSync(path.join(dir, "sub", "c.txt"), "nested junk\n");

    await store.rewindTo(base);

    assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf8"), "hello\n", "a.txt should be restored");
    assert.equal(fs.existsSync(path.join(dir, "b.txt")), false, "b.txt should be removed");
    assert.equal(fs.existsSync(path.join(dir, "sub", "c.txt")), false, "nested junk should be removed");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await check("rewind honors .gitignore (build output survives)", async () => {
    const dir = makeRepo();
    const store = await CheckpointStore.open(dir, "s1");
    const base = await store.snapshot("before turn");

    // Ignored path must NOT be captured in the snapshot nor deleted on rewind.
    fs.mkdirSync(path.join(dir, "ignored"), { recursive: true });
    fs.writeFileSync(path.join(dir, "ignored", "cache.bin"), "precious cache\n");
    fs.writeFileSync(path.join(dir, "a.txt"), "changed\n");

    const changes = await store.changesSince(base);
    assert.equal(changes.some((c) => c.path.startsWith("ignored/")), false, "ignored files must not appear in the diff");

    await store.rewindTo(base);
    assert.equal(fs.existsSync(path.join(dir, "ignored", "cache.bin")), true, "ignored build output must survive rewind");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await check("checkpoints chain and list newest-first", async () => {
    const dir = makeRepo();
    const store = await CheckpointStore.open(dir, "s1");
    const c1 = await store.snapshot("turn 1");
    fs.writeFileSync(path.join(dir, "a.txt"), "v2\n");
    const c2 = await store.snapshot("turn 2");

    const list = await store.list();
    assert.equal(list.length, 2);
    assert.equal(list[0].id, c2.id);
    assert.equal(list[0].label, "turn 2");
    assert.equal(list[1].id, c1.id);
    assert.equal(list[0].parent, c1.id, "newest checkpoint's parent is the previous one");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await check("private ref keeps HEAD/branch/working state untouched", async () => {
    const dir = makeRepo();
    const headBefore = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"]).toString().trim();
    const store = await CheckpointStore.open(dir, "s1");
    await store.snapshot("turn 1");
    const headAfter = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"]).toString().trim();
    assert.equal(headBefore, headAfter, "snapshot must not move HEAD");
    // The checkpoint lives under the private namespace, not on any branch.
    const branches = execFileSync("git", ["-C", dir, "branch", "--list"]).toString();
    assert.equal(branches.includes("checkpoint"), false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  if (failures > 0) {
    console.error(`\n${failures} checkpoint test(s) failed`);
    process.exit(1);
  }
  console.log("\nall checkpoint tests passed");
}

void main();
