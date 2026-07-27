// Unit tests for Claude Code's native session discovery (issue #156):
// src/runtime/claude-code.ts's discoverNativeClaudeSessions, which scans
// claudeProjectDirs() directly (independent of BIVY_CLAUDE_SESSIONS_DIR) so a
// session started by a bare `claude` outside Bivy is discoverable. Claude is
// not installed in CI here, so these write synthetic transcripts matching the
// documented on-disk layout ($CLAUDE_CONFIG_DIR or ~/.claude /projects/<slug>/
// <session-id>.jsonl) rather than asserting against a live Claude Code.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverNativeClaudeSessions } from "../src/runtime/claude-code.js";

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${(error as Error).stack ?? (error as Error).message}`);
  }
}

// Isolate CLAUDE_CONFIG_DIR to a scratch dir — this IS the "non-default
// provider home" case (claudeProjectDirs() checks this env var first).
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-native-sessions-test-"));
process.env.CLAUDE_CONFIG_DIR = tmpHome;

function writeSession(projectSlug: string, sessionId: string, lines: unknown[]): string {
  const dir = path.join(tmpHome, "projects", projectSlug);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
}

const SESSION_A = "11111111-2222-4333-8444-555555555555";
writeSession("-work-repo-a", SESSION_A, [
  { type: "user", message: { role: "user", content: "add a test" }, cwd: "/work/repo-a", timestamp: "2026-07-11T10:00:00.000Z" },
  { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "On it." }] }, cwd: "/work/repo-a", timestamp: "2026-07-11T10:00:01.000Z" },
]);

const SESSION_B = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const fileB = writeSession("-work-repo-b", SESSION_B, [
  { type: "user", message: { role: "user", content: "hello there" }, cwd: "/work/repo-b", timestamp: "2026-07-11T12:00:00.000Z" },
]);
// Back-date A relative to B so ordering is deterministic regardless of the
// speed the two writeSession() calls ran at.
fs.utimesSync(path.join(tmpHome, "projects", "-work-repo-a", `${SESSION_A}.jsonl`), new Date(1_752_220_800_000), new Date(1_752_220_800_000));
fs.utimesSync(fileB, new Date(1_752_235_200_000), new Date(1_752_235_200_000));

check("discovers every on-disk session, newest first, with bounded metadata", () => {
  const discovered = discoverNativeClaudeSessions(() => false);
  assert.equal(discovered.length, 2);
  assert.deepEqual(discovered.map((s) => s.ref), [SESSION_B, SESSION_A]);
  for (const s of discovered) {
    assert.equal(s.runtimeId, "claude-code-sdk");
    assert.equal(s.resumable, true, "every on-disk Claude session is resumable by its id");
    assert.equal(s.active, false);
    assert.equal((s as { messages?: unknown }).messages, undefined, "discovery must never carry transcript content");
  }
  const a = discovered.find((s) => s.ref === SESSION_A)!;
  assert.equal(a.cwd, "/work/repo-a");
  assert.equal(a.title, "add a test");
});

check("marks a session active when a live process is detected at its cwd", () => {
  const discovered = discoverNativeClaudeSessions((cwd) => cwd === "/work/repo-b");
  assert.equal(discovered.find((s) => s.ref === SESSION_A)!.active, false);
  assert.equal(discovered.find((s) => s.ref === SESSION_B)!.active, true);
});

check("skips a meta-only line when picking the title (first real user prompt)", () => {
  const id = "22222222-3333-4444-8555-666666666666";
  writeSession("-work-repo-c", id, [
    { type: "user", message: { role: "user", content: "task-notification: build finished" }, cwd: "/work/repo-c", isMeta: true, timestamp: "2026-07-11T09:00:00.000Z" },
    { type: "user", message: { role: "user", content: "actually fix the bug" }, cwd: "/work/repo-c", timestamp: "2026-07-11T09:00:01.000Z" },
  ]);
  const discovered = discoverNativeClaudeSessions(() => false);
  assert.equal(discovered.find((s) => s.ref === id)!.title, "actually fix the bug");
});

check("a corrupt/unparseable transcript line doesn't blank the whole session", () => {
  const id = "33333333-4444-4555-8666-777777777777";
  const dir = path.join(tmpHome, "projects", "-work-repo-d");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${id}.jsonl`),
    ["not json at all", JSON.stringify({ type: "user", message: { role: "user", content: "hi" }, cwd: "/work/repo-d" })].join("\n") + "\n",
  );
  const discovered = discoverNativeClaudeSessions(() => false);
  const found = discovered.find((s) => s.ref === id);
  assert.ok(found, "the readable line still yields a discovery entry");
  assert.equal(found!.cwd, "/work/repo-d");
});

check("honors a non-default CLAUDE_CONFIG_DIR with no store yet (empty list, no throw)", () => {
  const prev = process.env.CLAUDE_CONFIG_DIR;
  const otherHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-native-sessions-other-home-"));
  process.env.CLAUDE_CONFIG_DIR = otherHome;
  try {
    assert.deepEqual(discoverNativeClaudeSessions(() => false), []);
  } finally {
    process.env.CLAUDE_CONFIG_DIR = prev;
    fs.rmSync(otherHome, { recursive: true, force: true });
  }
});

check("unreadable/missing projects dir yields an empty list, not a throw", () => {
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = path.join(tmpHome, "does-not-exist");
  try {
    assert.deepEqual(discoverNativeClaudeSessions(() => false), []);
  } finally {
    process.env.CLAUDE_CONFIG_DIR = prev;
  }
});

try {
  fs.rmSync(tmpHome, { recursive: true, force: true });
} catch {
  // best-effort cleanup
}
delete process.env.CLAUDE_CONFIG_DIR;

if (failures > 0) {
  console.error(`\n${failures} Claude native-session test(s) failed.`);
  process.exit(1);
}
console.log("\nAll Claude native-session tests passed.");
