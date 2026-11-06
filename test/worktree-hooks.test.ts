// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWorktree, removeWorktree } from "../src/worktree.js";
import { worktreeSetupGate } from "../src/worktree-hooks.js";

function repo(files: Record<string, string>, ignored: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-wt-hooks-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  const write = (entries: Record<string, string>) => {
    for (const [rel, text] of Object.entries(entries)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    }
  };
  write(files);
  git("add", "-A");
  git("commit", "-qm", "init");
  write(ignored);
  return dir;
}

test("a new worktree gets the ignored files .worktreeinclude names, and nothing else", async () => {
  const dir = repo(
    { ".gitignore": ".env\nconfig/local/\n", ".worktreeinclude": ".env\nconfig/local/*.json\n!config/local/skip.json\nnotes.txt\n", "README.md": "hi\n" },
    { ".env": "TOKEN=1\n", "packages/web/.env": "WEB=1\n", "config/local/a.json": "{}", "config/local/skip.json": "{}", "notes.txt": "untracked, not ignored\n" },
  );
  try {
    const wt = await createWorktree({ repoDir: dir, id: "include" });
    assert.equal(fs.readFileSync(path.join(wt.path, ".env"), "utf8"), "TOKEN=1\n");
    assert.ok(fs.existsSync(path.join(wt.path, "packages/web/.env")), "an unanchored name matches at any depth");
    assert.ok(fs.existsSync(path.join(wt.path, "config/local/a.json")), "an anchored rule reaches into an ignored folder");
    assert.ok(!fs.existsSync(path.join(wt.path, "config/local/skip.json")), "a negation excludes");
    assert.ok(!fs.existsSync(path.join(wt.path, "notes.txt")), "a file git does not ignore is never copied");
    assert.equal(execFileSync("git", ["-C", wt.path, "status", "--porcelain"], { encoding: "utf8" }), "", "the copies leave the branch clean");
    await removeWorktree(wt.repoRoot, wt.path);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("setup runs in a new worktree and its result is reported once; teardown runs before removal", async () => {
  const marker = path.join(os.tmpdir(), `bivy-teardown-${process.pid}-${Date.now()}`);
  const dir = repo({
    ".bivy/environment.yaml": "version: 1\nworktree:\n  setup: { run: scripts/setup.sh }\n  teardown: { run: scripts/teardown.sh }\n",
    "scripts/setup.sh": "echo installing\necho ready > setup-ran.txt\n",
    "scripts/teardown.sh": `echo "$BIVY_WORKTREE_HOOK" > "${marker}"\n`,
    ".gitignore": "setup-ran.txt\n",
  });
  try {
    const wt = await createWorktree({ repoDir: dir, id: "hooks" });
    const gate = worktreeSetupGate(wt.path);
    assert.ok(gate?.report, "the first prompt reports the setup");
    const result = await gate!.result;
    assert.equal(result?.ok, true, result?.output);
    assert.equal(result?.output, "installing");
    assert.ok(fs.existsSync(path.join(wt.path, "setup-ran.txt")), "setup ran in the worktree");
    assert.equal(worktreeSetupGate(wt.path)?.report ?? false, false, "later prompts do not report it again");

    await removeWorktree(wt.repoRoot, wt.path);
    assert.equal(fs.readFileSync(marker, "utf8").trim(), "teardown");
    assert.ok(!fs.existsSync(wt.path), "the worktree is still removed");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(marker, { force: true });
  }
});

test("a failing setup is reported with its exit code and output", async () => {
  const dir = repo({
    ".bivy/environment.yaml": "version: 1\nworktree:\n  setup: { run: scripts/setup.sh }\n",
    "scripts/setup.sh": "echo missing dependency >&2\nexit 3\n",
  });
  try {
    const wt = await createWorktree({ repoDir: dir, id: "failing" });
    const result = await worktreeSetupGate(wt.path)!.result;
    assert.equal(result?.ok, false);
    assert.equal(result?.exitCode, 3);
    assert.equal(result?.output, "missing dependency");
    await removeWorktree(wt.repoRoot, wt.path);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
