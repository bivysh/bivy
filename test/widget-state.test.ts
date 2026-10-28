// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
// What chat widgets save: agent-written code chooses the bytes, so the store
// bounds them and keeps every file inside its own directory.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MAX_WIDGET_STATE_BYTES, MAX_WIDGETS_PER_SESSION, WidgetStateStore } from "../src/widgets/state.js";

function store() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "widget-state-"));
  return { dir, store: new WidgetStateStore(path.join(dir, "widget-state")) };
}

test("a widget's state comes back per session, and the oldest widget goes past the cap", () => {
  const { store: s } = store();
  s.set("s-1", "w:a", { choice: "B" }, 1);
  assert.deepEqual(s.all("s-1")["w:a"], { state: { choice: "B" }, updatedAt: 1 });
  assert.deepEqual(s.all("s-2"), {});
  for (let i = 0; i < MAX_WIDGETS_PER_SESSION; i++) s.set("s-1", `w:${i}`, i, 10 + i);
  const keys = Object.keys(s.all("s-1"));
  assert.equal(keys.length, MAX_WIDGETS_PER_SESSION);
  assert.ok(!keys.includes("w:a"), "the least recently saved widget is dropped");
});

test("oversized state, odd keys and path-like session ids are refused", () => {
  const { dir, store: s } = store();
  assert.throws(() => s.set("s-1", "w:a", "x".repeat(MAX_WIDGET_STATE_BYTES)), /can save up to/);
  assert.throws(() => s.set("s-1", "../escape", 1), /Invalid widget key/);
  assert.throws(() => s.set("../../escape", "w:a", 1), /Invalid session id/);
  assert.throws(() => s.all("../escape"), /Invalid session id/);
  assert.deepEqual(fs.readdirSync(dir), [], "nothing was written anywhere");
});
