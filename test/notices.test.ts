// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Notices: Bivy's own chat card replays where it was posted and lands once live;
// a `bivy notify` push goes out only when it should.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventLog } from "../src/session/event-log.js";
import { NOTICE_PUSH_GAP_MS, noticePush } from "../src/session/notices.js";
import { renderHistory } from "../packages/core/src/store-render.js";
import { SessionStore } from "../packages/core/src/store.js";

const notice = { id: "notice-0123456789abcdef", text: "Migration finished; all tests pass.", urgent: true };

test("a notice replays in place after a reload", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-notice-history-"));
  try {
    const create = () => new EventLog(dir, (id) => path.join(dir, `${id}.jsonl`));
    const log = create();
    log.appendBaseSnapshot("s", [{ role: "user", content: "Migrate the tables" }, { role: "assistant", content: "Starting." }]);
    log.appendNotice("s", { afterMessageCount: 2, notice });
    log.flush("s");
    const entries = renderHistory(create().deriveHistory("s"));
    assert.deepEqual(entries.map((entry) => entry.notice ? "notice" : entry.role), ["user", "assistant", "notice"]);
    assert.deepEqual(entries[2].notice, notice);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a live notice lands once and isn't a sign of work", () => {
  const store = new SessionStore();
  store.beginOpen("s");
  store.apply({ type: "session.history", sessionId: "s", messages: [] });
  for (let i = 0; i < 2; i++) store.apply({ type: "session.event", sessionId: "s", event: { type: "notice", id: notice.id, notice } });
  const { transcript, working } = store.getState().activeSession;
  assert.deepEqual(transcript.map((entry) => entry.notice), [notice]);
  assert.equal(working, false);
});

test("a notice pushes when the user is away, or urgently, at most once a minute", () => {
  const now = 1_000_000;
  assert.equal(noticePush({ userWatching: false, now }), "sent");
  assert.equal(noticePush({ userWatching: true, now }), "user_watching");
  assert.equal(noticePush({ userWatching: true, urgent: true, now }), "sent");
  assert.equal(noticePush({ userWatching: false, urgent: true, lastPushAt: now - 1000, now }), "rate_limited");
  assert.equal(noticePush({ userWatching: false, lastPushAt: now - NOTICE_PUSH_GAP_MS, now }), "sent");
  assert.equal(noticePush({ userWatching: false, now, pushConfigured: false }), "unavailable");
});
