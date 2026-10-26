// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// OpenCode 2 keeps sessions in session_v2/session_message and is written through
// its own CLI. A stub `opencode` on PATH records each call and the document it
// was asked to import, so the full read → fork → import path runs without
// OpenCode installed.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  deleteOpenCodeSession,
  discoverOpenCodeSessionForCwd,
  exportOpenCodeSession,
  importOpenCodeSession,
  loadOpenCodeTranscript,
  opencodeDbPath,
  writeOpenCodeHistory,
} from "../src/runtime/opencode-sessions.js";

const SOURCE = "ses_source00000000000000";

function withV2Store(): { calls: () => Array<{ args: string[]; document?: any }>; restore: () => void } {
  const prev = { XDG_DATA_HOME: process.env.XDG_DATA_HOME, PATH: process.env.PATH };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-oc2-"));
  process.env.XDG_DATA_HOME = dir;
  const log = path.join(dir, "calls.jsonl");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "opencode"), `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
const file = args[1] === "import" ? args.find((a) => a.endsWith(".json")) : undefined;
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, document: file ? JSON.parse(fs.readFileSync(file, "utf8")) : undefined }) + "\\n");
`, { mode: 0o755 });
  process.env.PATH = `${bin}${path.delimiter}${prev.PATH}`;

  fs.mkdirSync(path.dirname(opencodeDbPath()), { recursive: true });
  const db = new DatabaseSync(opencodeDbPath());
  db.exec(`
    CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, directory TEXT NOT NULL, title TEXT, version TEXT NOT NULL, cost REAL DEFAULT 0 NOT NULL, tokens_input INTEGER DEFAULT 0 NOT NULL, tokens_output INTEGER DEFAULT 0 NOT NULL, tokens_reasoning INTEGER DEFAULT 0 NOT NULL, tokens_cache_read INTEGER DEFAULT 0 NOT NULL, tokens_cache_write INTEGER DEFAULT 0 NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
  `);
  db.prepare("INSERT INTO session_v2 (id, project_id, directory, version, tokens_input, time_created, time_updated) VALUES (?, 'proj', '/src/cwd', '2.1.4', 40, 1000, 2000)").run(SOURCE);
  const rows: Array<[string, string, number, object]> = [
    ["msg_u", "user", 1, { time: { created: 1001 }, text: "hi", files: [] }],
    ["msg_a", "assistant", 2, { time: { created: 1002, completed: 1003 }, agent: "build", model: { id: "big-pickle", providerID: "opencode" }, content: [{ type: "reasoning", text: "thinking" }, { type: "text", text: "hello" }], finish: "stop" }],
    ["msg_i", "idle", 3, { time: { created: 1004 }, outcome: "succeeded" }],
  ];
  for (const [id, type, seq, data] of rows) {
    db.prepare("INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, SOURCE, type, seq, 1000 + seq, 1000 + seq, JSON.stringify(data));
  }
  db.close();
  return {
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []),
    restore: () => {
      for (const [key, value] of Object.entries(prev)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("reads a v2 store: transcript text and the session a run created", () => {
  const store = withV2Store();
  try {
    assert.deepEqual(loadOpenCodeTranscript(SOURCE).map((m) => [m.role, m.content]), [["user", "hi"], ["assistant", "hello"]]);
    assert.equal(discoverOpenCodeSessionForCwd("/src/cwd", 900)?.id, SOURCE);
    assert.equal(discoverOpenCodeSessionForCwd("/src/cwd", 10_000), undefined, "not one created before the run");
  } finally {
    store.restore();
  }
});

test("a same-agent fork imports the exported session under a new id in the fork's directory", async () => {
  const store = withV2Store();
  try {
    const payload = exportOpenCodeSession(SOURCE)!;
    const out = await importOpenCodeSession(payload, { workspace: "/dst", cwd: "/dst/cwd" });
    const [call] = store.calls();
    assert.deepEqual(call.args.slice(0, 4), ["session", "import", "--directory", "/dst/cwd"]);
    assert.ok(call.args.includes("--standalone"), "never starts OpenCode's background service");
    const doc = call.document;
    assert.equal(doc.info.id, out.id);
    assert.notEqual(out.id, SOURCE);
    assert.deepEqual(doc.info.location, { directory: "/dst/cwd" });
    assert.deepEqual(doc.messages.map((m: any) => m.type), ["user", "assistant", "idle"], "every message, in order");
    assert.deepEqual(doc.messages[1].content, [{ type: "reasoning", text: "thinking" }, { type: "text", text: "hello" }], "full content, not just text");
    assert.equal(new Set(doc.messages.map((m: any) => m.id)).has("msg_u"), false, "fresh message ids");
  } finally {
    store.restore();
  }
});

test("another agent's history becomes a v2 session; delete goes through the CLI", async () => {
  const store = withV2Store();
  try {
    const out = await writeOpenCodeHistory(
      [{ role: "user", text: "fix it" }, { role: "assistant", text: "fixed" }],
      { workspace: "/w", cwd: "/w", model: { provider: "openai", id: "gpt-5.6-sol" } },
    );
    const doc = store.calls()[0].document;
    assert.equal(doc.info.id, out.id);
    assert.deepEqual(doc.messages.map((m: any) => [m.type, m.text ?? m.content?.[0]?.text]), [["user", "fix it"], ["assistant", "fixed"]]);
    assert.deepEqual(doc.messages[1].model, { id: "gpt-5.6-sol", providerID: "openai" });

    assert.equal(await deleteOpenCodeSession(SOURCE), true);
    assert.deepEqual(store.calls()[1].args, ["session", "delete", SOURCE, "--standalone"]);
  } finally {
    store.restore();
  }
});
