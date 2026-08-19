// Unit tests for the OpenCode store writer/reader (src/runtime/opencode-sessions.ts).
//
// OpenCode stores its sessions in SQLite under $XDG_DATA_HOME/opencode/opencode.db;
// this is the same role codex-sessions.test.ts plays for Codex. These validate the
// writer against a SYNTHETIC store created with the real layout (session/message/part
// tables + the project FK), and lock in that a fork session reads back as the full
// transcript through the same message/part tables `opencode acp`'s session/load
// resumes. They do NOT depend on a live OpenCode; when the binary is installed, one
// check also verifies `opencode export` reconstructs the fork session natively.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import {
  opencodeDataDir,
  writeOpenCodeHistory,
  loadOpenCodeTranscript,
  deleteOpenCodeSession,
  discoverOpenCodeSessionForCwd,
} from "../src/runtime/opencode-sessions.js";
import type { ForkHistoryMessage } from "../src/runtime/types.js";

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

// Isolate XDG_DATA_HOME to a scratch dir so we never touch a real ~/.local/share.
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-sessions-test-"));
process.env.XDG_DATA_HOME = tmpData;

/** Recreate OpenCode's store schema (the tables the writer touches). */
function createStore(): string {
  const dir = path.join(opencodeDataDir());
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "opencode.db");
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    DROP TABLE IF EXISTS part;
    DROP TABLE IF EXISTS message;
    DROP TABLE IF EXISTS session;
    DROP TABLE IF EXISTS project;
    CREATE TABLE project (
      id TEXT PRIMARY KEY, worktree TEXT NOT NULL, vcs TEXT, name TEXT, icon_url TEXT,
      icon_url_override TEXT, icon_color TEXT, time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL, time_initialized INTEGER, sandboxes TEXT NOT NULL, commands TEXT
    );
    INSERT INTO project (id, worktree, vcs, time_created, time_updated, sandboxes) VALUES ('global', '/', NULL, 1, 1, '[]');
    CREATE TABLE session (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workspace_id TEXT, parent_id TEXT,
      slug TEXT NOT NULL, directory TEXT NOT NULL, path TEXT, title TEXT NOT NULL,
      version TEXT NOT NULL, share_url TEXT, summary_additions INTEGER, summary_deletions INTEGER,
      summary_files INTEGER, summary_diffs TEXT, metadata TEXT, cost REAL NOT NULL DEFAULT 0,
      tokens_input INTEGER NOT NULL DEFAULT 0, tokens_output INTEGER NOT NULL DEFAULT 0,
      tokens_reasoning INTEGER NOT NULL DEFAULT 0, tokens_cache_read INTEGER NOT NULL DEFAULT 0,
      tokens_cache_write INTEGER NOT NULL DEFAULT 0, revert TEXT, permission TEXT, agent TEXT,
      model TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
      time_compacting INTEGER, time_archived INTEGER,
      FOREIGN KEY (project_id) REFERENCES project (id) ON DELETE CASCADE
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL, data TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES session (id) ON DELETE CASCADE
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL,
      FOREIGN KEY (message_id) REFERENCES message (id) ON DELETE CASCADE
    );
  `);
  db.close();
  return file;
}

const HISTORY: ForkHistoryMessage[] = [
  { role: "user", text: "port the parser to rust" },
  { role: "assistant", text: "Starting the port." },
  { role: "user", text: "and add tests" },
];

function readStore(file: string): DatabaseSync {
  return new DatabaseSync(file, { readOnly: true });
}

check("writeOpenCodeHistory synthesises a session that reads back as the full transcript", () => {
  const file = createStore();
  const { id, sessionFile } = writeOpenCodeHistory(HISTORY, { workspace: "/w", cwd: "/work/ported" });
  assert.equal(sessionFile, id, "the resume ref is the session id");
  const db = readStore(file);
  const session = db.prepare("SELECT * FROM session WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  assert.ok(session, "the fork session row exists");
  assert.equal(session.project_id, "global");
  assert.equal(session.directory, "/work/ported");
  assert.equal(session.title, "Forked session");
  const messages = db.prepare("SELECT id FROM message WHERE session_id = ? ORDER BY time_created, id").all(id) as Array<{ id: string }>;
  assert.equal(messages.length, 3, "one message row per turn");
  const parts = db.prepare("SELECT * FROM part WHERE session_id = ?").all(id);
  assert.equal(parts.length, 3, "one text part per message");
  db.close();
  // Reads back through the same tables opencode acp session/load resumes.
  const msgs = loadOpenCodeTranscript(id) as Array<{ role: string; content: string }>;
  assert.deepEqual(msgs.map((m) => [m.role, m.content]), [
    ["user", "port the parser to rust"],
    ["assistant", "Starting the port."],
    ["user", "and add tests"],
  ]);
});

check("synthesised messages/parts carry OpenCode's JSON shapes", () => {
  const file = createStore();
  const { id } = writeOpenCodeHistory(HISTORY, { workspace: "/w", cwd: "/work/ported" });
  const db = readStore(file);
  const rows = db.prepare("SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, id").all(id) as Array<{ id: string; data: string }>;
  const user = JSON.parse(rows[0]!.data) as Record<string, unknown>;
  assert.equal(user.role, "user");
  assert.deepEqual(user.time, { created: (user.time as { created: number }).created });
  assert.deepEqual(user.model, { providerID: "opencode", modelID: "big-pickle" });
  const assistant = JSON.parse(rows[1]!.data) as Record<string, unknown>;
  assert.equal(assistant.role, "assistant");
  assert.equal(assistant.finish, "end_turn");
  assert.deepEqual(assistant.path, { cwd: "/work/ported", root: "/" });
  assert.equal(assistant.parentID, rows[0]!.id, "assistant chains onto the prior message");
  assert.deepEqual((assistant.tokens as Record<string, unknown>).total, 0);
  const partData = JSON.parse(db.prepare("SELECT data FROM part WHERE message_id = ?").get(rows[0]!.id)!.data as string) as Record<string, unknown>;
  assert.deepEqual(partData, { type: "text", text: "port the parser to rust" });
  db.close();
});

check("ctx.model is stamped on the fork session", () => {
  const file = createStore();
  const { id } = writeOpenCodeHistory([{ role: "user", text: "hi" }], {
    workspace: "/w",
    cwd: "/work/ported",
    model: { provider: "anthropic", id: "anthropic/claude-sonnet-4-5" },
  });
  const db = readStore(file);
  const session = db.prepare("SELECT model FROM session WHERE id = ?").get(id) as { model: string };
  assert.deepEqual(JSON.parse(session.model), { id: "anthropic/claude-sonnet-4-5", providerID: "anthropic" });
  const msg = JSON.parse(db.prepare("SELECT data FROM message WHERE session_id = ?").get(id)!.data as string) as { model: { providerID: string; modelID: string } };
  assert.deepEqual(msg.model, { providerID: "anthropic", modelID: "anthropic/claude-sonnet-4-5" });
  db.close();
});

check("writeOpenCodeHistory honors BIVY_OPENCODE_NO_FORK_REPLAY as an opt-out", () => {
  const prev = process.env.BIVY_OPENCODE_NO_FORK_REPLAY;
  process.env.BIVY_OPENCODE_NO_FORK_REPLAY = "1";
  try {
    assert.throws(() => writeOpenCodeHistory([{ role: "user", text: "x" }], { workspace: "/w", cwd: "/w" }), /disabled/);
  } finally {
    if (prev === undefined) delete process.env.BIVY_OPENCODE_NO_FORK_REPLAY;
    else process.env.BIVY_OPENCODE_NO_FORK_REPLAY = prev;
  }
});

check("writeOpenCodeHistory throws when the store is missing", () => {
  const missing = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-sessions-missing-"));
  const prev = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = missing;
  try {
    assert.throws(() => writeOpenCodeHistory([{ role: "user", text: "x" }], { workspace: "/w", cwd: "/w" }), /OpenCode store not found/);
    assert.deepEqual(loadOpenCodeTranscript("ses_x"), [], "reader stays best-effort on a missing store");
  } finally {
    process.env.XDG_DATA_HOME = prev;
    fs.rmSync(missing, { recursive: true, force: true });
  }
});

check("writeOpenCodeHistory throws on a store without the schema", () => {
  const dir = path.join(opencodeDataDir());
  fs.mkdirSync(dir, { recursive: true });
  const empty = path.join(dir, "opencode.db");
  fs.writeFileSync(empty, "");
  assert.throws(() => writeOpenCodeHistory([{ role: "user", text: "x" }], { workspace: "/w", cwd: "/w" }), /missing the "session" table/);
});

check("loadOpenCodeTranscript returns [] for an unknown session", () => {
  createStore();
  assert.deepEqual(loadOpenCodeTranscript("ses_does-not-exist"), []);
});

check("deleteOpenCodeSession removes the session and its rows", () => {
  const file = createStore();
  const { id } = writeOpenCodeHistory(HISTORY, { workspace: "/w", cwd: "/work/ported" });
  const db = readStore(file);
  assert.equal((db.prepare("SELECT count(*) AS c FROM message WHERE session_id = ?").get(id) as { c: number }).c, 3);
  db.close();
  assert.equal(deleteOpenCodeSession(id), true, "removes an existing fork session");
  assert.equal(deleteOpenCodeSession(id), false, "second delete finds nothing");
  assert.equal(deleteOpenCodeSession("ses_never-existed"), false, "unknown id is not an error");
  assert.deepEqual(loadOpenCodeTranscript(id), [], "session is gone from the store");
  const after = readStore(file);
  assert.equal((after.prepare("SELECT count(*) AS c FROM message WHERE session_id = ?").get(id) as { c: number }).c, 0, "messages cascade-deleted");
  after.close();
});

check("discoverOpenCodeSessionForCwd finds the run's session by cwd + start time", () => {
  const file = createStore();
  const db = new DatabaseSync(file);
  const insert = db.prepare("INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated) VALUES (?, 'global', ?, 's', ?, 't', '1.18.18', ?, ?)");
  insert.run("ses_old", null, "/work/repo", 10_000, 10_000);          // before the run started
  insert.run("ses_other", null, "/work/elsewhere", 100_000, 100_000); // another cwd
  insert.run("ses_run", null, "/work/repo", 98_000, 98_000);          // the run (inside the 5 s clock skew)
  insert.run("ses_child", "ses_run", "/work/repo", 101_000, 101_000); // a subagent child — never the run itself
  insert.run("ses_later", null, "/work/repo", 150_000, 150_000);      // a later TUI in the same cwd
  db.close();
  assert.equal(discoverOpenCodeSessionForCwd("/work/repo", 100_000)?.id, "ses_run", "earliest top-level session in this cwd since the run began");
  assert.equal(discoverOpenCodeSessionForCwd("/work/repo/../repo", 100_000)?.id, "ses_run", "cwd is resolved before matching");
  assert.equal(discoverOpenCodeSessionForCwd("/work/nowhere", 0), undefined);
  const missing = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-sessions-missing-"));
  const prev = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = missing;
  try {
    assert.equal(discoverOpenCodeSessionForCwd("/work/repo", 0), undefined, "missing store is not an error");
  } finally {
    process.env.XDG_DATA_HOME = prev;
    fs.rmSync(missing, { recursive: true, force: true });
  }
});

check("opencode export reconstructs the fork session (live, when installed)", () => {
  const probe = spawnSync("opencode", ["--version"], { encoding: "utf8", timeout: 20_000 });
  if (probe.error || probe.status !== 0) {
    console.log("  ~  opencode binary not available — skipping live check");
    return;
  }
  // Let opencode initialize a fresh store (running its own migrations), then write
  // the fork session into it — this asserts the writer's rows are the real layout.
  const liveData = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-sessions-live-"));
  const prevData = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = liveData;
  const init = spawnSync("opencode", ["session", "list"], { encoding: "utf8", timeout: 60_000, env: { ...process.env, XDG_DATA_HOME: liveData } });
  assert.equal(init.status, 0, `opencode init exited ${init.status}: ${init.stderr?.slice(0, 300)}`);
  try {
    const workDir = path.join(liveData, "work");
    fs.mkdirSync(workDir, { recursive: true });
    const { id } = writeOpenCodeHistory(HISTORY, { workspace: "/w", cwd: workDir });
    const exported = spawnSync("opencode", ["export", id], { encoding: "utf8", timeout: 60_000, env: { ...process.env, XDG_DATA_HOME: liveData } });
    assert.equal(exported.status, 0, `opencode export exited ${exported.status}: ${exported.stderr?.slice(0, 500)}`);
    assert.match(exported.stdout, /port the parser to rust/);
    assert.match(exported.stdout, /Starting the port\./);
    assert.match(exported.stdout, /and add tests/);
    const listed = spawnSync("opencode", ["session", "list"], { encoding: "utf8", timeout: 60_000, env: { ...process.env, XDG_DATA_HOME: liveData }, cwd: workDir });
    if (listed.status === 0) assert.match(listed.stdout, new RegExp(id), "the fork session shows up in opencode session list");
  } finally {
    if (prevData === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prevData;
    fs.rmSync(liveData, { recursive: true, force: true });
  }
});

try {
  fs.rmSync(tmpData, { recursive: true, force: true });
} catch {
  // best-effort cleanup
}

if (failures > 0) {
  console.error(`\n${failures} OpenCode sessions test(s) failed.`);
  process.exit(1);
}
console.log("\nAll OpenCode sessions tests passed.");
