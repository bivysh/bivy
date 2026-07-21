import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PiRuntime } from "../src/runtime/pi.js";
import { ClaudeCodeRuntime } from "../src/runtime/claude-code.js";
import { ProcessRuntime } from "../src/runtime/process.js";
import { ProtocolRuntime } from "../src/runtime/protocol.js";
import { listCodexSessions, deleteCodexSession } from "../src/runtime/codex-sessions.js";

// Regression for "deleted sessions reappear in the sidebar shortly after": a
// user-initiated delete cleared Bivy's metadata but not the OWNING runtime's own
// on-disk store (Claude Code's ~/.claude, Codex's $CODEX_HOME) or its in-memory
// registry, so the next listSessions re-surfaced the row. Every supported agent
// must now honor AgentRuntime.deleteSession: the session is gone from the next
// listSessions AND from the runtime's store, and deleting an unknown id is a
// no-op (false), never a throw.

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- pi: lists purely from disk, so delete must unlink the transcript file ----
{
  const piDir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-del-pi-"));
  const sessionsDir = path.join(piDir, "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });

  const sm = SessionManager.create(process.cwd(), sessionsDir);
  sm.appendMessage({ role: "user", content: "delete me" });
  sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "ok" }] });
  const id = sm.getSessionId();
  const file = sm.getSessionFile();
  assert.ok(file, "pi session file should be persisted");

  const pi = new PiRuntime({ credsDir: piDir, piDir, sessionsDir });
  assert.ok((await pi.listSessions()).some((s) => s.id === id), "pi lists the session before delete");

  assert.equal(await pi.deleteSession(id), true, "pi.deleteSession reports it removed the session");
  assert.ok(!(await pi.listSessions()).some((s) => s.id === id), "pi session is gone from the next listSessions");
  assert.ok(!fs.existsSync(file!), "pi transcript file is unlinked");

  // Idempotent / unknown-id safe: a second delete (or an unknown id) is a no-op.
  assert.equal(await pi.deleteSession(id), false, "re-deleting a gone pi session is a no-op, not a throw");
  assert.equal(await pi.deleteSession(randomUUID()), false, "deleting an unknown pi id is a no-op");
}

// --- Claude Code: reads its own store by id (~/.claude/projects/<cwd>/<id>) ----
{
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-del-claude-"));
  const projectDir = path.join(claudeHome, "projects", "-home-user-proj");
  fs.mkdirSync(projectDir, { recursive: true });
  const claudeId = randomUUID();
  const transcript = path.join(projectDir, `${claudeId}.jsonl`);
  const jsonl = [
    { type: "user", message: { role: "user", content: "hi" }, timestamp: "2026-01-01T00:00:00Z" },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "yo" }] }, timestamp: "2026-01-01T00:00:01Z" },
  ].map((e) => JSON.stringify(e)).join("\n");
  fs.writeFileSync(transcript, `${jsonl}\n`);

  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  try {
    const claude = new ClaudeCodeRuntime();
    // readMessages is what listAllSessions' backfill reads from the store — a
    // proxy for "present in the store" that needs no SDK/BIVY_CLAUDE_SESSIONS_DIR.
    assert.equal(claude.readMessages(claudeId)!.length, 2, "Claude store has the session before delete");

    assert.equal(await claude.deleteSession(claudeId), true, "claude.deleteSession removes the transcript");
    assert.ok(!fs.existsSync(transcript), "Claude transcript file is unlinked");
    assert.deepEqual(claude.readMessages(claudeId), [], "Claude store no longer has the session");

    assert.equal(await claude.deleteSession(randomUUID()), false, "deleting an unknown Claude id is a no-op");
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
  }
}

// --- Codex store helper: the on-disk rollout cleanup both CLI/protocol paths use
{
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-del-codex-"));
  const dayDir = path.join(codexHome, "sessions", "2026", "01", "01");
  fs.mkdirSync(dayDir, { recursive: true });
  const rolloutId = randomUUID();
  const rollout = path.join(dayDir, `rollout-2026-01-01T00-00-00-${rolloutId}.jsonl`);
  const lines = [
    { id: rolloutId, cwd: "/tmp/proj", timestamp: "2026-01-01T00:00:00Z" },
    { role: "user", content: "delete this codex session", timestamp: "2026-01-01T00:00:01Z" },
  ].map((e) => JSON.stringify(e)).join("\n");
  fs.writeFileSync(rollout, `${lines}\n`);

  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  try {
    assert.ok(listCodexSessions().some((s) => s.id === rolloutId), "codex store lists the rollout before delete");

    assert.equal(deleteCodexSession(rolloutId), true, "deleteCodexSession removes the rollout");
    assert.ok(!listCodexSessions().some((s) => s.id === rolloutId), "codex rollout is gone from the next list");
    assert.ok(!fs.existsSync(rollout), "codex rollout file is unlinked");

    assert.equal(deleteCodexSession(randomUUID()), false, "deleting an unknown codex id is a no-op");
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prev;
  }
}

// --- ProcessRuntime (generic CLI / Codex exec): in-memory splice + deleteHistory
{
  const deleted: string[] = [];
  // command "true" is never spawned here (createSession doesn't launch until a
  // prompt), so this exercises the registry + cleanup without a real agent.
  const proc = new ProcessRuntime({ command: "true", resumable: true, deleteHistory: (id) => deleted.push(id) });
  const { session } = await proc.createSession({ workspace: process.cwd() });
  const id = session.id;
  assert.ok((await proc.listSessions()).some((s) => s.id === id), "process runtime lists the live session");

  assert.equal(await proc.deleteSession(id), true, "process.deleteSession removes the session");
  assert.ok(!(await proc.listSessions()).some((s) => s.id === id), "process session is gone from the next listSessions");
  assert.deepEqual(deleted, [id], "process delete forwards to the store cleanup (deleteHistory) by id");
}

// --- ProtocolRuntime (Codex app-server shim, other protocol agents) -----------
{
  const fixture = path.join(__dirname, "fixtures/protocol-agent.mjs");
  const deleted: string[] = [];
  const proto = new ProtocolRuntime({
    command: process.execPath,
    args: [fixture],
    displayName: "Fixture Protocol",
    deleteHistory: (ref) => deleted.push(ref),
  });
  const { session } = await proto.createSession({ workspace: process.cwd(), toolInterceptor: async () => undefined });
  const id = session.id;
  assert.ok((await proto.listSessions()).some((s) => s.id === id), "protocol runtime lists the live session");

  assert.equal(await proto.deleteSession(id), true, "protocol.deleteSession removes the session");
  assert.ok(!(await proto.listSessions()).some((s) => s.id === id), "protocol session is gone from the next listSessions");
  assert.ok(deleted.includes(id), "protocol delete forwards to the store cleanup (deleteHistory)");
}

console.log("runtime-delete-session: all tests passed");
