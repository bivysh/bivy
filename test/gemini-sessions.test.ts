import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  discoverGeminiFamilySessionForCwd,
  listGeminiFamilySessions,
  loadGeminiFamilyTranscript,
} from "../src/runtime/gemini-sessions.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-gemini-family-"));
const prevGemini = process.env.GEMINI_CLI_HOME;
const prevQwen = process.env.QWEN_HOME;
process.env.GEMINI_CLI_HOME = path.join(root, "gemini");
process.env.QWEN_HOME = path.join(root, "qwen");

try {
  const geminiCwd = path.join(root, "gemini-workspace");
  const geminiChats = path.join(process.env.GEMINI_CLI_HOME, "tmp", "gemini-workspace", "chats");
  fs.mkdirSync(geminiChats, { recursive: true });
  fs.writeFileSync(path.join(path.dirname(geminiChats), ".project_root"), geminiCwd);
  fs.writeFileSync(path.join(geminiChats, "session-2026-01-01-gemini123.jsonl"), [
    { sessionId: "gemini-session-id", projectHash: "hash", startTime: "2026-01-01T00:00:00Z" },
    { id: "u1", type: "user", content: [{ text: "hello Gemini" }], timestamp: "2026-01-01T00:00:01Z" },
    { id: "a1", type: "gemini", content: [{ text: "hello back" }], timestamp: "2026-01-01T00:00:02Z" },
  ].map(JSON.stringify).join("\n") + "\n");

  const gemini = listGeminiFamilySessions("gemini");
  assert.equal(gemini.length, 1);
  assert.equal(gemini[0]!.id, "gemini-session-id");
  assert.equal(gemini[0]!.cwd, geminiCwd);
  assert.deepEqual(loadGeminiFamilyTranscript("gemini", "gemini-session-id").map((m) => m.role), ["user", "assistant"]);
  assert.equal(discoverGeminiFamilySessionForCwd("gemini", geminiCwd, Date.parse("2026-01-01T00:00:00Z"))?.id, "gemini-session-id");

  const qwenCwd = path.join(root, "qwen-workspace");
  const qwenChats = path.join(process.env.QWEN_HOME, "projects", "qwen-workspace", "chats");
  fs.mkdirSync(qwenChats, { recursive: true });
  fs.writeFileSync(path.join(qwenChats, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl"), [
    { sessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", cwd: qwenCwd, timestamp: "2026-01-02T00:00:00Z" },
    { id: "u1", type: "user", content: "hello Qwen", timestamp: "2026-01-02T00:00:01Z" },
    { id: "a1", type: "assistant", content: [{ text: "ready" }], timestamp: "2026-01-02T00:00:02Z" },
  ].map(JSON.stringify).join("\n") + "\n");

  const qwen = listGeminiFamilySessions("qwen");
  assert.equal(qwen.length, 1);
  assert.equal(qwen[0]!.cwd, qwenCwd);
  assert.equal(qwen[0]!.firstMessage, "hello Qwen");
  assert.deepEqual(loadGeminiFamilyTranscript("qwen", qwen[0]!.id).map((m) => m.role), ["user", "assistant"]);
} finally {
  if (prevGemini === undefined) delete process.env.GEMINI_CLI_HOME;
  else process.env.GEMINI_CLI_HOME = prevGemini;
  if (prevQwen === undefined) delete process.env.QWEN_HOME;
  else process.env.QWEN_HOME = prevQwen;
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("gemini-family sessions: ok");
