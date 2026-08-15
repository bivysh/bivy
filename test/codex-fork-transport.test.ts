// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { exportCodexRollout, importCodexRollout, codexSessionsDir } from "../src/runtime/codex-sessions.js";

function withCodexHome(): { home: string; restore: () => void } {
  const prev = process.env.CODEX_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-codex-home-"));
  process.env.CODEX_HOME = home;
  return { home, restore: () => { if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev; } };
}

/** Seed a rollout file with a session_meta line + two response_items. */
function seedRollout(id: string, cwd: string): string {
  const dir = path.join(codexSessionsDir(), "2026", "08", "15");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-08-15T00-00-00-000-${id}.jsonl`);
  const lines = [
    { type: "session_meta", timestamp: "2026-08-15T00:00:00.000Z", payload: { session_id: id, id, cwd, originator: "codex", timestamp: "2026-08-15T00:00:00.000Z" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] } },
    { type: "response_item", payload: { type: "reasoning", summary: "thinking about it" } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] } },
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
}

test("export → import round-trips byte-exact response_items into a fresh session", () => {
  const { home, restore } = withCodexHome();
  try {
    const srcFile = seedRollout("11111111-1111-1111-1111-111111111111", "/src/cwd");
    const payload = exportCodexRollout("11111111-1111-1111-1111-111111111111");
    assert.ok(payload, "exported a payload for the known session");
    assert.equal(payload!.runtimeId, "codex");
    assert.equal(payload!.kind, "codex-rollout");

    const out = importCodexRollout(payload!, { workspace: "/dst", cwd: "/dst/cwd" });
    assert.notEqual(out.id, "11111111-1111-1111-1111-111111111111", "minted a new id");
    assert.equal(out.sessionFile, out.id);

    // The source rollout is untouched.
    assert.ok(fs.existsSync(srcFile));

    // The new rollout exists, carries the new id/cwd in meta, and preserved every
    // response_item verbatim — including the `reasoning` record the replay path drops.
    const newFile = fs.readdirSync(path.join(codexSessionsDir(), "2026", "08", "15")).find((f) => f.includes(out.id));
    assert.ok(newFile, "wrote a new rollout file for the forked id");
    const lines = fs.readFileSync(path.join(codexSessionsDir(), "2026", "08", "15", newFile!), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(lines[0].payload.session_id, out.id, "meta session_id rewritten");
    assert.equal(lines[0].payload.id, out.id, "meta id rewritten");
    assert.equal(lines[0].payload.cwd, "/dst/cwd", "meta cwd rewritten to the destination");
    assert.deepEqual(lines.slice(1), [
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] } },
      { type: "response_item", payload: { type: "reasoning", summary: "thinking about it" } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] } },
    ], "every response_item (incl. reasoning) carried over verbatim");
  } finally {
    restore();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("export returns undefined for an unknown session", () => {
  const { home, restore } = withCodexHome();
  try {
    assert.equal(exportCodexRollout("nope"), undefined);
  } finally {
    restore();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("import throws on a bad payload so the fork engine can degrade", () => {
  const { home, restore } = withCodexHome();
  try {
    assert.throws(() => importCodexRollout({ runtimeId: "codex", kind: "wrong", data: {} }, { workspace: "/w", cwd: "/w" }), /Unexpected Codex fork payload kind/);
    assert.throws(() => importCodexRollout({ runtimeId: "codex", kind: "codex-rollout", data: {} }, { workspace: "/w", cwd: "/w" }), /no rollout data/);
    assert.throws(() => importCodexRollout({ runtimeId: "codex", kind: "codex-rollout", data: { jsonl: "not json\n" } }, { workspace: "/w", cwd: "/w" }), /not valid JSON metadata/);
    assert.throws(() => importCodexRollout({ runtimeId: "codex", kind: "codex-rollout", data: { jsonl: JSON.stringify({ type: "response_item", payload: {} }) + "\n" } }, { workspace: "/w", cwd: "/w" }), /does not start with session metadata/);
  } finally {
    restore();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("import honors BIVY_CODEX_NO_FORK_REPLAY escape hatch", () => {
  const { home, restore } = withCodexHome();
  const prev = process.env.BIVY_CODEX_NO_FORK_REPLAY;
  process.env.BIVY_CODEX_NO_FORK_REPLAY = "1";
  try {
    seedRollout("22222222-2222-2222-2222-222222222222", "/src");
    const payload = exportCodexRollout("22222222-2222-2222-2222-222222222222")!;
    assert.throws(() => importCodexRollout(payload, { workspace: "/w", cwd: "/w" }), /disabled/);
  } finally {
    if (prev === undefined) delete process.env.BIVY_CODEX_NO_FORK_REPLAY; else process.env.BIVY_CODEX_NO_FORK_REPLAY = prev;
    restore();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
