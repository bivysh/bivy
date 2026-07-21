import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HarnessManager } from "../src/harness/manager.js";

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-hm-"));
  git(dir, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "initial");
  return dir;
}

async function main() {
  await check("attach returns false for a non-repo (harness disabled, no throw)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-hm-nogit-"));
    const hm = new HarnessManager();
    assert.equal(await hm.attach("s1", dir), false);
    assert.equal(hm.isTracking("s1"), false);
    // All lifecycle calls are safe no-ops when untracked.
    await hm.beginTurn("s1", "t1");
    assert.equal(await hm.endTurn("s1", "done"), undefined);
    assert.deepEqual(await hm.checkpoints("s1"), []);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await check("begin/end turn returns the structured diff a turn produced", async () => {
    const dir = makeRepo();
    const hm = new HarnessManager();
    assert.equal(await hm.attach("s1", dir), true);

    await hm.beginTurn("s1", "before turn 1");
    fs.writeFileSync(path.join(dir, "a.txt"), "hello world\n");
    fs.writeFileSync(path.join(dir, "b.txt"), "created\n");
    const result = await hm.endTurn("s1", "after turn 1");

    assert.ok(result, "endTurn should return changes for a tracked session");
    assert.equal(result!.changes.length, 2);
    const byPath = Object.fromEntries(result!.changes.map((c) => [c.path, c]));
    assert.equal(byPath["a.txt"].status, "modified");
    assert.equal(byPath["b.txt"].status, "added");
    assert.ok(result!.before, "a non-first turn records a base checkpoint");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await check("endTurn without beginTurn is undefined; empty turn yields no changes", async () => {
    const dir = makeRepo();
    const hm = new HarnessManager();
    await hm.attach("s1", dir);
    assert.equal(await hm.endTurn("s1", "x"), undefined, "no base → undefined");

    await hm.beginTurn("s1", "before");
    const result = await hm.endTurn("s1", "after"); // no file changes
    assert.ok(result);
    assert.deepEqual(result!.changes, []);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await check("rewind restores the workspace to a checkpoint", async () => {
    const dir = makeRepo();
    const hm = new HarnessManager();
    await hm.attach("s1", dir);
    await hm.beginTurn("s1", "before");
    const done = await hm.endTurn("s1", "after");
    const base = done!.before!;

    // A later turn wrecks the tree.
    fs.writeFileSync(path.join(dir, "a.txt"), "wrecked\n");
    fs.writeFileSync(path.join(dir, "junk.txt"), "junk\n");

    await hm.rewind("s1", base.id);
    assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf8"), "hello\n");
    assert.equal(fs.existsSync(path.join(dir, "junk.txt")), false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await check("beginTurn is idempotent within a turn (re-prompt keeps the base)", async () => {
    const dir = makeRepo();
    const hm = new HarnessManager();
    await hm.attach("s1", dir);
    await hm.beginTurn("s1", "before");
    fs.writeFileSync(path.join(dir, "a.txt"), "mid-turn edit\n");
    await hm.beginTurn("s1", "second begin (should be ignored)");
    const result = await hm.endTurn("s1", "after");
    // If the base were overwritten by the second beginTurn, the mid-turn edit
    // would be lost from the diff. It must still be reported.
    assert.ok(result!.changes.some((c) => c.path === "a.txt" && c.status === "modified"));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await check("rewind on an untracked session throws", async () => {
    const hm = new HarnessManager();
    await assert.rejects(() => hm.rewind("nope", "deadbeef"));
  });

  if (failures > 0) {
    console.error(`\n${failures} harness-manager test(s) failed`);
    process.exit(1);
  }
  console.log("\nall harness-manager tests passed");
}

void main();
