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
  discoverNativeCodexSessions,
  writeCodexRollout,
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

// --- Native discovery/adoption (issue #156) ---------------------------------

check("discoverNativeCodexSessions returns bounded metadata for every session with an id, newest first", () => {
  const discovered = discoverNativeCodexSessions(() => false); // no live process for any cwd
  assert.equal(discovered.length, 2);
  assert.deepEqual(discovered.map((s) => s.ref), [SESSION_B, SESSION_A]);
  for (const s of discovered) {
    assert.equal(s.runtimeId, "codex-approvals");
    assert.equal(s.resumable, true, "every Codex session with a recorded id is resumable via `codex exec resume <id>`");
    assert.equal(s.active, false);
    // Bounded metadata only — no transcript content anywhere on the shape.
    assert.equal((s as { messages?: unknown }).messages, undefined);
  }
  const b = discovered.find((s) => s.ref === SESSION_B)!;
  assert.equal(b.cwd, "/work/other");
  assert.equal(b.file, fileB);
});

check("discoverNativeCodexSessions marks a session active when a live process is detected at its cwd", () => {
  const discovered = discoverNativeCodexSessions((cwd) => cwd === "/work/repo");
  const a = discovered.find((s) => s.ref === SESSION_A)!;
  const b = discovered.find((s) => s.ref === SESSION_B)!;
  assert.equal(a.active, true);
  assert.equal(b.active, false);
});

check("discoverNativeCodexSessions omits a session Codex never assigned an id to (nothing to resume by)", () => {
  writeRollout("2026/07/12", "rollout-2026-07-12T09-00-00-no-id.jsonl", [
    { cwd: "/work/no-id" },
    { role: "user", content: "hi", timestamp: "2026-07-12T09:00:01.000Z" },
  ]);
  const discovered = discoverNativeCodexSessions(() => false);
  assert.ok(!discovered.some((s) => s.cwd === "/work/no-id"));
});

check("discoverNativeCodexSessions honors a non-default CODEX_HOME (no throw, empty list)", () => {
  const prev = process.env.CODEX_HOME;
  const otherHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-sessions-other-home-"));
  process.env.CODEX_HOME = otherHome;
  try {
    assert.deepEqual(discoverNativeCodexSessions(() => false), []);
  } finally {
    process.env.CODEX_HOME = prev;
    fs.rmSync(otherHome, { recursive: true, force: true });
  }
});

// --- writeCodexRollout: the write-side of a true "replayed" fork INTO Codex ---

check("writeCodexRollout synthesises a rollout that reads back as the full transcript", () => {
  const { id, sessionFile } = writeCodexRollout(
    [
      { role: "user", text: "port the parser to rust" },
      { role: "assistant", text: "Starting the port." },
    ],
    "/work/ported",
  );
  assert.equal(sessionFile, id, "the resume ref is the rollout id");
  // Reads back through the ordinary reader as an in-order user/assistant turn pair.
  const msgs = loadCodexTranscript(id) as Array<{ role: string; content: string }>;
  assert.deepEqual(msgs.map((m) => [m.role, m.content]), [["user", "port the parser to rust"], ["assistant", "Starting the port."]]);
  // Discoverable by id and by cwd, exactly like a real Codex rollout.
  const discovered = discoverNativeCodexSessions(() => false).find((s) => s.ref === id);
  assert.ok(discovered, "the synthesised rollout is discoverable by id");
  assert.equal(discovered!.cwd, "/work/ported");
  assert.equal(discoverCodexSessionForCwd("/work/ported")?.id, id, "locatable by cwd for resume");
});

check("writeCodexRollout honors BIVY_CODEX_NO_FORK_REPLAY as an opt-out", () => {
  const prev = process.env.BIVY_CODEX_NO_FORK_REPLAY;
  process.env.BIVY_CODEX_NO_FORK_REPLAY = "1";
  try {
    assert.throws(() => writeCodexRollout([{ role: "user", text: "x" }], "/work/x"), /disabled/);
  } finally {
    if (prev === undefined) delete process.env.BIVY_CODEX_NO_FORK_REPLAY;
    else process.env.BIVY_CODEX_NO_FORK_REPLAY = prev;
  }
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
