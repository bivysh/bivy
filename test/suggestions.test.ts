// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventLog } from "../src/session/event-log.js";
import { renderHistory } from "../packages/core/src/store-render.js";
import { SessionStore } from "../packages/core/src/store.js";
import { focusEntries } from "../packages/web/src/focusTranscript.js";
import { isTaskSuggestion } from "../src/session/suggestions.js";

const suggestion = { id: "suggestion-0123456789abcdef", text: "Add a /version endpoint that returns the package version and git commit.", title: "Add /version" };

test("a suggested task replays in place after a reload", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-suggestion-history-"));
  try {
    const create = () => new EventLog(dir, (id) => path.join(dir, `${id}.jsonl`));
    const log = create();
    log.appendBaseSnapshot("s", [{ role: "user", content: "Show me around" }, { role: "assistant", content: "Here are three ideas." }]);
    log.appendSuggestion("s", { afterMessageCount: 2, suggestion });
    log.flush("s");
    const entries = renderHistory(create().deriveHistory("s"));
    assert.deepEqual(entries.map((entry) => entry.suggestion ? "suggestion" : entry.role), ["user", "assistant", "suggestion"]);
    assert.deepEqual(entries[2].suggestion, suggestion);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a live suggestion lands once, stays in Focus mode, and isn't a sign of work", () => {
  const store = new SessionStore();
  store.beginOpen("s");
  store.apply({ type: "session.history", sessionId: "s", messages: [] });
  for (let i = 0; i < 2; i++) store.apply({ type: "session.event", sessionId: "s", event: { type: "suggestion", id: suggestion.id, suggestion } });
  const { transcript, working } = store.getState().activeSession;
  assert.deepEqual(transcript.map((entry) => entry.suggestion), [suggestion]);
  assert.equal(working, false);
  assert.deepEqual(focusEntries([...transcript, { id: "final", role: "assistant", text: "Pick one." }], false).find((entry) => entry.suggestion)?.suggestion, suggestion);
});

test("a suggestion's recommended run is one of here, subagents or new", () => {
  assert.equal(isTaskSuggestion({ ...suggestion, run: "subagents" }), true);
  assert.equal(isTaskSuggestion({ ...suggestion, run: "later" }), false);
});
