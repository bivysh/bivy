// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { strict as assert } from "node:assert";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  checkpointRef,
  createCheckpointBundle,
  applyCheckpointBundle,
  materializeCheckpoint,
} from "../src/session/checkpoint-pack.js";

const exec = promisify(execFile);
const SID = "sess-abc";

async function git(cwd: string, ...args: string[]) {
  return exec("git", ["-C", cwd, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e.c",
      GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e.c",
    },
  });
}

/** Make a checkpoint commit of the current tree under the session's checkpoint ref. */
async function checkpoint(repo: string, file: string, content: string): Promise<string> {
  await fs.promises.writeFile(path.join(repo, file), content);
  await git(repo, "add", "-A");
  const tree = (await git(repo, "write-tree")).stdout.trim();
  const ref = checkpointRef(SID);
  const parent = await git(repo, "rev-parse", "--verify", "--quiet", ref).then((r) => r.stdout.trim()).catch(() => "");
  const args = ["commit-tree", tree, "-m", "cp", ...(parent ? ["-p", parent] : [])];
  const sha = (await git(repo, ...args)).stdout.trim();
  await git(repo, "update-ref", ref, sha);
  return sha;
}

async function tmpRepo(): Promise<string> {
  const dir = path.join(os.tmpdir(), `bivy-ckpt-test-${randomUUID()}`);
  await fs.promises.mkdir(dir, { recursive: true });
  await git(dir, "init", "-q");
  return dir;
}

test("full bundle: a fresh standby receives the whole checkpoint and materializes it", async () => {
  const owner = await tmpRepo();
  await checkpoint(owner, "f.txt", "v1");
  const c2 = await checkpoint(owner, "f.txt", "v2");

  const bundle = await createCheckpointBundle(owner, SID);
  assert.ok(bundle && bundle.length > 0, "a full bundle is produced");

  const replica = await tmpRepo();
  const res = await applyCheckpointBundle(replica, SID, bundle!);
  assert.deepEqual(res, { ok: true });
  assert.equal((await git(replica, "rev-parse", checkpointRef(SID))).stdout.trim(), c2);

  await materializeCheckpoint(replica, SID);
  assert.equal(await fs.promises.readFile(path.join(replica, "f.txt"), "utf8"), "v2");
});

test("incremental bundle: a warm standby applies only the new turn", async () => {
  const owner = await tmpRepo();
  await checkpoint(owner, "f.txt", "v1");
  const c2 = await checkpoint(owner, "f.txt", "v2");

  // Standby catches up to c2 via a full bundle.
  const replica = await tmpRepo();
  await applyCheckpointBundle(replica, SID, (await createCheckpointBundle(owner, SID))!);

  // Owner takes another turn; the incremental bundle carries just c3.
  const c3 = await checkpoint(owner, "f.txt", "v3");
  const incr = await createCheckpointBundle(owner, SID, c2);
  assert.ok(incr && incr.length > 0);

  const res = await applyCheckpointBundle(replica, SID, incr!);
  assert.deepEqual(res, { ok: true });
  assert.equal((await git(replica, "rev-parse", checkpointRef(SID))).stdout.trim(), c3);
  await materializeCheckpoint(replica, SID);
  assert.equal(await fs.promises.readFile(path.join(replica, "f.txt"), "utf8"), "v3");
});

test("nothing to send: no checkpoint ref, or standby already at the tip", async () => {
  const owner = await tmpRepo();
  assert.equal(await createCheckpointBundle(owner, SID), null, "no ref yet → null");
  const c1 = await checkpoint(owner, "f.txt", "v1");
  assert.equal(await createCheckpointBundle(owner, SID, c1), null, "standby at tip → null");
});

test("thin bundle with a missing prerequisite asks for a full resend", async () => {
  const owner = await tmpRepo();
  await checkpoint(owner, "f.txt", "v1");
  const c2 = await checkpoint(owner, "f.txt", "v2");
  const c3 = await checkpoint(owner, "f.txt", "v3");

  // Incremental since c2, but the standby never received c2 → prerequisite absent.
  const incr = await createCheckpointBundle(owner, SID, c2);
  assert.ok(incr);
  const replica = await tmpRepo();
  const res = await applyCheckpointBundle(replica, SID, incr!);
  assert.deepEqual(res, { ok: false, needFull: true }, "reports needFull so the owner sends everything");
  void c3;
});
