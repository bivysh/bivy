// Unit tests for the Codex rollout reader (src/runtime/codex-sessions.ts).
//
// Codex is not installed in CI here, so these validate the reader against a
// synthetic rollout fixture written to match the DOCUMENTED Codex layout
// ($CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl, first line = session
// meta, rest = items). The reader is deliberately defensive (tolerates a wrapped
// `{type,payload}` or a flat record, skips malformed lines), so these lock in
// that behavior; they do NOT assert against a live Codex.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  codexSessionsDir,
  listCodexSessions,
  loadCodexTranscript,
  loadCodexTranscriptFile,
  discoverCodexSessionForCwd,
} from "../src/runtime/codex-sessions.js";

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

// Isolate CODEX_HOME to a scratch dir so we never touch a real ~/.codex.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-sessions-test-"));
process.env.CODEX_HOME = tmpHome;

function writeRollout(relDir: string, fileName: string, lines: unknown[]): string {
  const dir = path.join(codexSessionsDir(), relDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, fileName);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
}

// A session in the "wrapped" record layout ({type, payload, timestamp}).
const SESSION_A = "11111111-2222-4333-8444-555555555555";
const fileA = writeRollout("2026/07/11", `rollout-2026-07-11T10-00-00-${SESSION_A}.jsonl`, [
  { type: "session_meta", timestamp: "2026-07-11T10:00:00.000Z", payload: { id: SESSION_A, cwd: "/work/repo", cli_version: "0.x" } },
  { type: "response_item", timestamp: "2026-07-11T10:00:01.000Z", payload: { role: "user", content: "add a test" } },
  { type: "response_item", timestamp: "2026-07-11T10:00:02.000Z", payload: { role: "assistant", content: [{ type: "text", text: "On it." }] } },
  { type: "event_msg", payload: { type: "token_count", total: 42 } }, // non-message, ignored
]);

// A session in the "flat" record layout (no payload envelope), different cwd, later.
const SESSION_B = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const fileB = writeRollout("2026/07/11", `rollout-2026-07-11T12-00-00-${SESSION_B}.jsonl`, [
  { id: SESSION_B, timestamp: "2026-07-11T12:00:00.000Z", cwd: "/work/other" },
  { role: "user", content: "hello", timestamp: "2026-07-11T12:00:01.000Z" },
  "this line is not json — must be skipped",
  { role: "assistant", content: "hi there", timestamp: "2026-07-11T12:00:02.000Z" },
]);

check("enumerates both sessions, newest first", () => {
  const sessions = listCodexSessions();
  assert.equal(sessions.length, 2, "two rollouts found");
  assert.equal(sessions[0].id, SESSION_B, "newest (B) first");
  assert.equal(sessions[1].id, SESSION_A);
  assert.equal(sessions[0].cwd, "/work/other");
  assert.equal(sessions[1].firstMessage, "add a test");
});

check("reconstructs a transcript (wrapped layout, string + block content)", () => {
  const msgs = loadCodexTranscriptFile(fileA) as Array<{ role: string; content: string }>;
  assert.deepEqual(
    msgs.map((m) => [m.role, m.content]),
    [["user", "add a test"], ["assistant", "On it."]],
  );
});

check("reconstructs a transcript (flat layout) and skips non-JSON lines", () => {
  const msgs = loadCodexTranscriptFile(fileB) as Array<{ role: string; content: string }>;
  assert.deepEqual(
    msgs.map((m) => [m.role, m.content]),
    [["user", "hello"], ["assistant", "hi there"]],
  );
});

check("loadCodexTranscript resolves by session id", () => {
  const msgs = loadCodexTranscript(SESSION_A) as Array<{ role: string }>;
  assert.equal(msgs.length, 2);
  assert.equal(loadCodexTranscript("no-such-id").length, 0);
});

check("discoverCodexSessionForCwd matches by cwd + since", () => {
  const found = discoverCodexSessionForCwd("/work/repo");
  assert.equal(found?.id, SESSION_A);
  // A cwd with no session → undefined.
  assert.equal(discoverCodexSessionForCwd("/nope"), undefined);
  // `since` in the future (after the session started) → filtered out.
  assert.equal(discoverCodexSessionForCwd("/work/repo", Date.parse("2027-01-01T00:00:00Z")), undefined);
});

check("missing sessions dir yields an empty list (no throw)", () => {
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.join(tmpHome, "does-not-exist");
  assert.deepEqual(listCodexSessions(), []);
  process.env.CODEX_HOME = prev;
});

try {
  fs.rmSync(tmpHome, { recursive: true, force: true });
} catch {
  // best-effort cleanup
}

if (failures > 0) {
  console.error(`\n${failures} Codex sessions test(s) failed.`);
  process.exit(1);
}
console.log("\nAll Codex sessions tests passed.");
