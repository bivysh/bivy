import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PiRuntime } from "../src/runtime/pi.js";
import { ClaudeCodeRuntime } from "../src/runtime/claude-code.js";

// AgentRuntime.readMessages is the fast, build-free transcript read behind opening
// a session in the sidebar: every wrapped agent reads its persisted transcript
// straight from disk instead of standing up the (multi-second) live runtime, so
// opening is uniformly fast across agents. Each adapter must return the SAME list
// a freshly resumed session would expose via getMessages().

// --- pi: buildSessionContext() is exactly what a live resume loads ---

const piDir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-pi-"));
const sessionsDir = path.join(piDir, "sessions");
fs.mkdirSync(sessionsDir, { recursive: true });

// Persist a session file the way a real turn would (user prompt + assistant reply).
const sm = SessionManager.create(process.cwd(), sessionsDir);
sm.appendMessage({ role: "user", content: "resume me fast" });
sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "done" }] });
const sessionFile = sm.getSessionFile();
assert.ok(sessionFile, "session file should be persisted");

const rt = new PiRuntime({ credsDir: piDir, piDir, sessionsDir });

// The fast read returns the transcript without building a runtime.
const messages = rt.readMessages(sessionFile!);
assert.ok(messages, "readMessages should return a transcript for a valid session file");
assert.equal(messages!.length, 2, "both persisted messages should be read back");
assert.deepEqual(
  messages!.map((m) => (m as { role: string }).role),
  ["user", "assistant"],
  "roles round-trip through the file read",
);

// It matches buildSessionContext() exactly — the same source a live resume uses.
const viaContext = SessionManager.open(sessionFile!, sessionsDir).buildSessionContext().messages;
assert.deepEqual(messages, viaContext, "readMessages equals buildSessionContext().messages");

// A missing/corrupt file must not throw — it reads as an empty transcript, which
// the caller (fastHistoryEvent) treats as "nothing to fast-paint" and skips.
const missing = rt.readMessages(path.join(sessionsDir, "nope.jsonl"));
assert.deepEqual(missing, [], "a missing session file reads as an empty transcript, not a throw");

// --- Claude Code: same contract, reading its own on-disk transcript by id ---
// The runtime resumes by session id and its adapter reads ~/.claude (or
// CLAUDE_CONFIG_DIR) /projects/<cwd>/<id>.jsonl — the exact read a resumed
// ClaudeSession does in its constructor (this.messages = loadClaudeTranscript).
const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-claude-"));
const projectDir = path.join(claudeHome, "projects", "-home-user-proj");
fs.mkdirSync(projectDir, { recursive: true });
const claudeSessionId = "11111111-2222-3333-4444-555555555555";
const jsonl = [
  { type: "user", message: { role: "user", content: "hi claude" }, timestamp: "2026-01-01T00:00:00Z" },
  // Model-only meta the CLI writes for itself must be DROPPED, not replayed as
  // chat. One relies on the isMeta flag, one on the text net (a task-notification
  // block with no flag), exercising both drop paths.
  { type: "user", isMeta: true, message: { role: "user", content: [{ type: "text", text: "<system-reminder>do the thing</system-reminder>" }] }, timestamp: "2026-01-01T00:00:00.3Z" },
  { type: "user", message: { role: "user", content: [{ type: "text", text: "<task-notification><status>completed</status></task-notification>" }] }, timestamp: "2026-01-01T00:00:00.4Z" },
  // A genuine user Stop (no shutdown flag) is ALWAYS kept as "Stopped by user.".
  { type: "user", message: { role: "user", content: "[Request interrupted by user]" }, timestamp: "2026-01-01T00:00:00.5Z" },
  // A teardown/restart the session CONTINUED PAST (assistant reply follows) was
  // recovered — e.g. a credential-reload re-drive — so it's dropped as noise.
  { type: "user", interruptedByShutdown: true, message: { role: "user", content: "[Request interrupted by user]" }, timestamp: "2026-01-01T00:00:00.6Z" },
  { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hello!" }] }, timestamp: "2026-01-01T00:00:01Z" },
  // A TRAILING restart — the session actually ended interrupted — IS surfaced.
  { type: "user", interruptedByShutdown: true, message: { role: "user", content: "[Request interrupted by user]" }, timestamp: "2026-01-01T00:00:02Z" },
].map((e) => JSON.stringify(e)).join("\n");
fs.writeFileSync(path.join(projectDir, `${claudeSessionId}.jsonl`), `${jsonl}\n`);

const prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
process.env.CLAUDE_CONFIG_DIR = claudeHome;
try {
  const claude = new ClaudeCodeRuntime();
  const claudeMsgs = claude.readMessages(claudeSessionId);
  assert.ok(claudeMsgs, "Claude readMessages returns a transcript for a stored session");
  // Kept: user prompt, "Stopped by user." notice, assistant reply, trailing
  // "restarted" notice. Dropped: 2 model-only meta turns + the mid (recovered)
  // restart notice.
  assert.equal(claudeMsgs!.length, 4, "user Stop + trailing restart shown; meta + recovered restart dropped");
  assert.deepEqual(
    claudeMsgs!.map((m) => (m as { role: string }).role),
    ["user", "system", "assistant", "system"],
    "interrupt markers become system notices in place; a recovered restart is dropped",
  );
  // The raw marker/tags must not survive as chat text — the interrupt is shown as
  // a labeled notice instead, and a teardown is never blamed on the user.
  const claudeText = JSON.stringify(claudeMsgs);
  assert.ok(!claudeText.includes("Request interrupted"), "the raw '[Request interrupted by user]' marker text is gone");
  assert.ok(!claudeText.includes("task-notification"), "the <task-notification> block is filtered out");
  assert.ok(!claudeText.includes("system-reminder"), "the isMeta <system-reminder> turn is filtered out");
  assert.equal((claudeMsgs![1] as { content: string }).content, "Stopped by user.", "an unflagged interrupt is always kept, labeled a user Stop");
  assert.equal((claudeMsgs![3] as { content: string }).content, "Interrupted — the session was restarted.", "a trailing shutdown interrupt is labeled a restart, not a user Stop");
  // An unknown session id reads empty (no throw) — the uniform fall-back signal.
  assert.deepEqual(
    claude.readMessages("00000000-0000-0000-0000-000000000000"),
    [],
    "an unknown Claude session reads as empty, not a throw",
  );
} finally {
  if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
}

console.log("runtime-read-messages: all tests passed");
