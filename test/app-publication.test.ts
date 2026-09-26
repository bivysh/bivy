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
import { foldTranscriptEvent, freshTranscriptDraft, type TranscriptFoldValue } from "../packages/core/src/transcript-event-fold.js";
import { focusEntries } from "../packages/web/src/focusTranscript.js";

const app = { appId: "a".repeat(32), sessionId: "s", name: "Invoice workbench" };
test("app launchers survive history replay without persisting any access grants", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-app-history-"));
  try {
    const create = () => new EventLog(dir, (id) => path.join(dir, `${id}.jsonl`));
    const log = create();
    log.appendBaseSnapshot("s", [{ role: "user", content: "Build an invoice editor" }]);
    log.appendAppPublication("s", { id: `app-${app.appId}`, afterMessageCount: 1, app });
    log.flush("s");
    const entries = renderHistory(create().deriveHistory("s"));
    assert.deepEqual(entries.find((entry) => entry.app)?.app, app);
    const raw = fs.readFileSync(path.join(dir, "s.jsonl"), "utf8");
    assert.ok(!raw.includes("https://") && !raw.includes("ticket"));
    assert.equal(entries.filter((entry) => entry.app).length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("live app publications deduplicate and stay visible in Focus mode", () => {
  const initial: TranscriptFoldValue = { transcript: [], draft: freshTranscriptDraft(), pendingAgentAttachments: [], working: true, workingLabel: "Working" };
  const event = { type: "app_published", app };
  const first = foldTranscriptEvent(initial, event, 1).value;
  const second = foldTranscriptEvent(first, event, 2).value;
  assert.equal(second.transcript.length, 1);
  assert.equal(foldTranscriptEvent(initial, { type: "app_published", app: { name: "invalid" } }, 1).value.transcript.length, 0);
  const entries = [...second.transcript, { id: "final", role: "assistant" as const, text: "Your app is ready." }];
  for (const working of [true, false]) assert.deepEqual(focusEntries(entries, working).find((entry) => entry.app)?.app, app);
});

test("session envelopes deliver launchers to the focused chat without starting a turn", () => {
  const store = new SessionStore();
  store.beginOpen("s");
  store.apply({ type: "session.history", sessionId: "s", messages: [] });
  store.apply({ type: "session.event", sessionId: "other", event: { type: "app_published", app } });
  assert.equal(store.getState().activeSession.transcript.length, 0);
  store.apply({ type: "session.event", sessionId: "s", event: { type: "app_published", app } });
  assert.deepEqual(store.getState().activeSession.transcript[0].app, app);
  assert.equal(store.getState().activeSession.working, false);
});


test("a review card replays as its latest state, once, after a reload", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-review-history-"));
  try {
    const create = () => new EventLog(dir, (id) => path.join(dir, `${id}.jsonl`));
    const log = create();
    const review = { id: "review-0123456789abcdef", sessionId: "s", appId: app.appId, viewId: "b".repeat(32), name: app.name, view: "Site", path: "/", trigger: "run" as const, at: 1, shot: { hash: "c".repeat(64), size: 1, width: 780, height: 1688 } };
    log.appendBaseSnapshot("s", [{ role: "user", content: "Tidy the invoice table" }, { role: "assistant", content: "Done." }]);
    log.appendAppReview("s", { afterMessageCount: 1, createdAt: 1, review });
    log.appendAppReview("s", { afterMessageCount: 2, createdAt: 2, review: { ...review, trigger: "present", note: "Ready" } });
    log.flush("s");
    const cards = renderHistory(create().deriveHistory("s")).filter((entry) => entry.review);
    assert.deepEqual(cards.map((entry) => [entry.review?.trigger, entry.review?.note, entry.review?.shot?.hash]), [["present", "Ready", "c".repeat(64)]]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
