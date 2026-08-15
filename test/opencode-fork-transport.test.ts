// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { exportOpenCodeSession, importOpenCodeSession, opencodeDbPath } from "../src/runtime/opencode-sessions.js";

function withStore(): { dir: string; restore: () => void } {
  const prev = process.env.XDG_DATA_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-oc-"));
  process.env.XDG_DATA_HOME = dir;
  return { dir, restore: () => { if (prev === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = prev; } };
}

/** Build a minimal OpenCode-shaped store with one rich source session. */
function seed(): { srcId: string; userMsgId: string; asstMsgId: string } {
  fs.mkdirSync(path.dirname(opencodeDbPath()), { recursive: true });
  const db = new DatabaseSync(opencodeDbPath());
  db.exec(`
    CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT, vcs TEXT, name TEXT, icon_url TEXT, icon_url_override TEXT, icon_color TEXT, time_created INTEGER, time_updated INTEGER, time_initialized INTEGER, sandboxes TEXT, commands TEXT);
    CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, workspace_id TEXT, parent_id TEXT, slug TEXT, directory TEXT, path TEXT, title TEXT, version TEXT, cost REAL, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER, model TEXT, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
  `);
  const srcId = "ses_source0000000000000000";
  const userMsgId = "msg_user000000000000000000";
  const asstMsgId = "msg_asst000000000000000000";
  db.prepare("INSERT INTO project (id, time_created, time_updated, sandboxes) VALUES ('global', 1, 1, '[]')").run();
  db.prepare("INSERT INTO session (id, project_id, slug, directory, path, title, version, model, time_created, time_updated) VALUES (?, 'global', 'src-slug', '/src/cwd', 'src/cwd', 'Src', '1.18.18', ?, 100, 200)")
    .run(srcId, JSON.stringify({ id: "big-pickle", providerID: "opencode" }));
  db.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, 101, 101, ?)")
    .run(userMsgId, srcId, JSON.stringify({ role: "user", time: { created: 101 } }));
  // Assistant carries a rich data blob incl. a parentID pointing at the user msg
  // and tokens — the fidelity the replayed path would have dropped.
  db.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, 102, 102, ?)")
    .run(asstMsgId, srcId, JSON.stringify({ role: "assistant", parentID: userMsgId, sessionID: srcId, tokens: { input: 5, output: 7 }, modelID: "big-pickle" }));
  db.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('prt_u', ?, ?, 101, 101, ?)")
    .run(userMsgId, srcId, JSON.stringify({ type: "text", text: "hi" }));
  db.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('prt_a', ?, ?, 102, 102, ?)")
    .run(asstMsgId, srcId, JSON.stringify({ type: "text", text: "hello" }));
  db.close();
  return { srcId, userMsgId, asstMsgId };
}

function openRead(): DatabaseSync { return new DatabaseSync(opencodeDbPath(), { readOnly: true }); }

test("export → import clones the session with new ids and full per-message data", () => {
  const { restore, dir } = withStore();
  try {
    const { srcId, asstMsgId } = seed();
    const payload = exportOpenCodeSession(srcId);
    assert.ok(payload, "exported the source session");
    assert.equal(payload!.runtimeId, "opencode");
    assert.equal(payload!.kind, "opencode-rows");

    const out = importOpenCodeSession(payload!, { workspace: "/dst", cwd: "/dst/cwd", model: { provider: "anthropic", id: "claude-opus-4-8" } });
    assert.match(out.id, /^ses_/, "minted a new session id");
    assert.notEqual(out.id, srcId);

    const db = openRead();
    try {
      // Source session untouched.
      const srcMsgs = db.prepare("SELECT COUNT(*) c FROM message WHERE session_id = ?").get(srcId) as { c: number };
      assert.equal(srcMsgs.c, 2, "source messages untouched");

      // New session row retargeted.
      const ses = db.prepare("SELECT * FROM session WHERE id = ?").get(out.id) as any;
      assert.ok(ses, "new session row exists");
      assert.equal(ses.directory, "/dst/cwd", "directory retargeted");
      assert.equal(ses.path, "dst/cwd", "path retargeted (no leading slash)");
      assert.equal(ses.project_id, "global");
      assert.notEqual(ses.slug, "src-slug", "slug regenerated to avoid collision");
      assert.deepEqual(JSON.parse(ses.model), { id: "claude-opus-4-8", providerID: "anthropic" }, "requested model stamped");

      // New messages: 2, with the assistant's parentID + sessionID remapped.
      const msgs = db.prepare("SELECT * FROM message WHERE session_id = ? ORDER BY time_created").all(out.id) as any[];
      assert.equal(msgs.length, 2);
      const newUserId = msgs[0].id;
      const asst = JSON.parse(msgs[1].data);
      assert.equal(asst.parentID, newUserId, "assistant parentID remapped to the new user message id");
      assert.equal(asst.sessionID, out.id, "nested sessionID remapped");
      assert.deepEqual(asst.tokens, { input: 5, output: 7 }, "rich token data preserved (the fidelity win)");
      assert.notEqual(msgs[1].id, asstMsgId, "message id remapped");

      // Parts remapped and text preserved.
      const parts = db.prepare("SELECT * FROM part WHERE session_id = ? ORDER BY time_created").all(out.id) as any[];
      assert.equal(parts.length, 2);
      assert.equal(parts[0].message_id, newUserId, "part message_id remapped");
      assert.equal(JSON.parse(parts[1].data).text, "hello", "part text preserved");
    } finally {
      db.close();
    }
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("export returns undefined for an unknown session / missing store", () => {
  const { restore, dir } = withStore();
  try {
    assert.equal(exportOpenCodeSession("ses_nope"), undefined, "missing store → undefined");
    seed();
    assert.equal(exportOpenCodeSession("ses_nope"), undefined, "unknown id → undefined");
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("import throws on a bad payload and honors the escape hatch", () => {
  const { restore, dir } = withStore();
  try {
    seed();
    assert.throws(() => importOpenCodeSession({ runtimeId: "opencode", kind: "wrong", data: {} }, { workspace: "/w", cwd: "/w" }), /Unexpected OpenCode fork payload kind/);
    assert.throws(() => importOpenCodeSession({ runtimeId: "opencode", kind: "opencode-rows", data: {} }, { workspace: "/w", cwd: "/w" }), /no session row/);
    const prev = process.env.BIVY_OPENCODE_NO_FORK_REPLAY;
    process.env.BIVY_OPENCODE_NO_FORK_REPLAY = "1";
    try {
      assert.throws(() => importOpenCodeSession({ runtimeId: "opencode", kind: "opencode-rows", data: { session: { id: "x" } } }, { workspace: "/w", cwd: "/w" }), /disabled/);
    } finally {
      if (prev === undefined) delete process.env.BIVY_OPENCODE_NO_FORK_REPLAY; else process.env.BIVY_OPENCODE_NO_FORK_REPLAY = prev;
    }
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
