// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ControlPlaneTaskPoller, type WorkItem } from "../src/control-plane-tasks.js";
import { createWorktree } from "../src/worktree.js";

const exec = promisify(execFile);
const directory = mkdtempSync(path.join(tmpdir(), "bivy-retry-worktree-"));
const originalFetch = globalThis.fetch;
try {
  await exec("git", ["-C", directory, "init", "-q"]);
  await exec("git", ["-C", directory, "config", "user.name", "Test"]);
  await exec("git", ["-C", directory, "config", "user.email", "test@example.com"]);
  writeFileSync(path.join(directory, "output.txt"), "base");
  await exec("git", ["-C", directory, "add", "."]);
  await exec("git", ["-C", directory, "commit", "-qm", "base"]);

  const item: WorkItem = { id: "durable-run", label: "bivy", source: "schedule", status: "pending", title: "Work", attempt: 1, maxAttempts: 2 };
  let completions = 0;
  globalThis.fetch = async url => {
    const endpoint = String(url).split("/").at(-1);
    if (endpoint === "complete") completions++;
    return Response.json(endpoint === "claim"
      ? { item: { ...item, claimToken: "current-worker", leaseExpiresAt: new Date(Date.now() + 60000).toISOString() } }
      : endpoint === "attempt" ? { item: { ...item, attempt: 2 } } : {});
  };

  const attempts: number[] = [];
  const poller = new ControlPlaneTaskPoller({ controlPlaneUrl: "https://cp.test", enrollmentToken: "test", labels: ["bivy"], pollMs: 60000 }, async received => {
    attempts.push(received.attempt!);
    // The server's generic repo-backed runner requests the same output branch
    // on every policy attempt. Exercise that boundary with real dirty Git data.
    const worktree = await createWorktree({ repoDir: directory, id: "bivy/run-stable", branch: "bivy/run-stable" });
    if (received.attempt === 1) {
      writeFileSync(path.join(worktree.path, "output.txt"), "partial agent output");
      writeFileSync(path.join(worktree.path, "untracked.txt"), "unfinished new file");
      throw new Error("provider connection dropped before commit");
    }
    assert.equal(readFileSync(path.join(worktree.path, "output.txt"), "utf8"), "partial agent output");
    assert.equal(readFileSync(path.join(worktree.path, "untracked.txt"), "utf8"), "unfinished new file");
  }, undefined, {
    policy: { decide: () => ({ action: "retry", delayMs: 0, condition: "transport_error", summary: "Retry" }) },
  });
  await (poller as unknown as { runOne(item: WorkItem): Promise<void> }).runOne(item);
  assert.deepEqual(attempts, [1, 2]);
  assert.equal(completions, 1, "retry finishes with the previous attempt's uncommitted work intact");
  console.log("✓ policy retry preserves dirty repo worktree output");
} finally {
  globalThis.fetch = originalFetch;
  rmSync(directory, { recursive: true, force: true });
}
