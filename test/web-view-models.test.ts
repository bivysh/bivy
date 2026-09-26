// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Pure PWA view-model rules: the functions components render from. They need
// neither a browser nor a Vite server.
import assert from "node:assert/strict";
import test from "node:test";
import type { AccountAutomationRun, TranscriptEntry } from "@bivy/core";
import { isListedAutomation } from "../packages/web/src/automationList.js";
import { compactCronSummary, formatAutomationMoment, formatNextAutomationRun } from "../packages/web/src/automationPresentation.js";
import { buildChangeSetReviewPrompt, buildFileReviewPrompt, type ReviewPromptFile } from "../packages/web/src/changeReviewPrompt.js";
import { captureChatScroll, restoredChatScrollTop } from "../packages/web/src/chatScroll.js";
import { nativeSessionLink } from "../packages/web/src/native-session-link.js";
import { runHistoryCategory } from "../packages/web/src/components/RunHistory.js";
import { sessionDateGroup } from "../packages/web/src/sessionPresentation.js";
import { attentionRank, isUnseen, statusClass, statusLabel } from "../packages/web/src/sessionStatus.js";
import { modelAccountChoice } from "../packages/web/src/modelAccounts.js";
import { githubInstallationSettings, githubMentionHandles, githubSourceStatus } from "../packages/web/src/components/githubSource.js";
import { focusEntries } from "../packages/web/src/focusTranscript.js";
import { standbyCopyOf } from "../packages/web/src/standby.js";

test("account routing follows project, active, default and ambiguity rules", () => {
  const records = [{ label: "default" }, { label: "work" }];
  const config = { active: "personal", presets: { personal: { anthropic: "default" }, default: { anthropic: "work" }, "project:acme/app": { anthropic: "work" } } };
  assert.deepEqual(modelAccountChoice("anthropic", records, config, "acme/app"), { preset: "project:acme/app", label: "work" });
  assert.deepEqual(modelAccountChoice("anthropic", records, config), { preset: "personal", label: "default" });
  assert.deepEqual(modelAccountChoice("anthropic", records, config, "/repos/acme__app/.bivy/worktrees/session"), { preset: "project:/repos/acme__app/.bivy/worktrees/session", label: "work" });
  assert.equal(modelAccountChoice("anthropic", records, { presets: { default: { anthropic: "work" } } }).label, "work");
  assert.equal(modelAccountChoice("anthropic", records, {}).label, "default");
  assert.equal(modelAccountChoice("anthropic", [{ label: "work" }], {}).label, "work");
  assert.equal(modelAccountChoice("anthropic", [{ label: "home" }, { label: "work" }], {}).label, undefined);
  assert.equal(modelAccountChoice("anthropic", records, { active: "bad", presets: { bad: { anthropic: "missing" } } }).label, undefined);
  assert.equal(modelAccountChoice("anthropic", records, null).label, undefined);
});

test("GitHub status does not conflate hosted installation with executor readiness", () => {
  const installation = { installationId: "42", githubAccount: "acme", githubAccountType: "Organization", createdAt: "2026-09-01" };
  const hosted = { connected: true, appId: "123", central: true, hosted: true, installed: true, mention: "bivy-hosted", name: "Hosted Bivy App", servedBy: null, installations: [installation] };
  const custom = { connected: true, appId: "456", installed: true, mention: "acme-bot", name: "Acme custom app", servedBy: null };
  const hostedStatus = githubSourceStatus({ connected: true, apps: [hosted] });
  assert.equal(hostedStatus.tone, "on");
  assert.equal(hostedStatus.label, "Hosted Bivy App connected");
  assert.equal(githubSourceStatus({ connected: true, apps: [custom] }).label, "Custom GitHub App connected");
  assert.equal(githubSourceStatus({ connected: true, apps: [hosted, custom] }).label, "Hosted + custom apps connected");
  assert.equal(githubSourceStatus(null).label, "Status unavailable");
  assert.equal(githubSourceStatus({ connected: false, apps: [] }).tone, "off");
  assert.deepEqual(githubMentionHandles({ connected: true, apps: [hosted, custom] }), ["bivy-hosted", "acme-bot"]);
  assert.deepEqual(githubMentionHandles({ connected: true, apps: [hosted, custom] }, "456"), ["acme-bot"]);
  assert.deepEqual(githubMentionHandles(null), []);
  assert.equal(githubInstallationSettings(installation), "https://github.com/organizations/acme/settings/installations/42");
  assert.equal(githubInstallationSettings({ ...installation, githubAccountType: "User" }), "https://github.com/settings/installations/42");
});

test("Focus view keeps attachments while hiding intermediate prose", () => {
  const image = { kind: "image" as const, name: "result.png", size: 42, mimeType: "image/png", hash: "a".repeat(64) };
  const user: TranscriptEntry = { id: "user", role: "user", text: "Show me" };

  // An earlier attachment is carried onto the final answer.
  const carried = focusEntries([
    user,
    { id: "commentary", role: "assistant", text: "I’ll attach it.", attachments: [image] },
    { id: "tool", role: "assistant", text: "", tool: { callId: "attach", name: "shell", input: {}, status: "done" } },
    { id: "final", role: "assistant", text: "Attached." },
  ], false);
  assert.deepEqual(carried.map((entry) => entry.id), ["user", "final"]);
  assert.deepEqual(carried[1]?.attachments, [image]);

  // An attachment-only turn is kept.
  const only = focusEntries([user, { id: "attachment", role: "assistant", text: "", attachments: [image] }], false)[1];
  assert.equal(only?.id, "attachment");
  assert.deepEqual(only?.attachments, [image]);

  // An attachment already on the final answer is not duplicated.
  const grouped = focusEntries([
    user,
    { id: "attachment", role: "assistant", text: "", attachments: [image] },
    { id: "final", role: "assistant", text: "Attached.", attachments: [image] },
  ], false);
  assert.deepEqual(grouped[1]?.attachments, [image]);

  // In-progress prose is hidden, emitted attachments are not.
  const working = focusEntries([user, { id: "working", role: "assistant", text: "Interim narration", streaming: true, attachments: [image] }], true)[1];
  assert.equal(working?.id, "working");
  assert.equal(working?.text, "");
  assert.equal(working?.streaming, false);
  assert.deepEqual(working?.attachments, [image]);
});

test("automation list and dates: one-off schedules are hidden; nearby runs read relatively", () => {
  assert.equal(isListedAutomation({ schedule: { kind: "once", at: "2026-08-27T09:00:00.000Z" } }), false);
  assert.equal(isListedAutomation({ schedule: { kind: "cron", expression: "0 9 * * *", timezone: "UTC" } }), true);
  const now = new Date(2026, 7, 13, 9, 0);
  const opts = { now, locale: "en-GB" };
  assert.equal(formatAutomationMoment(new Date(2026, 7, 13, 20, 19), opts), "Today at 20:19");
  assert.equal(formatAutomationMoment(new Date(2026, 7, 14, 12, 0), opts), "Tomorrow at 12:00");
  assert.equal(formatAutomationMoment(new Date(2026, 7, 15, 8, 30), opts), "Saturday at 08:30");
  assert.match(formatAutomationMoment(new Date(2027, 0, 3, 9, 5), opts), /^3 Jan 2027 at 09:05$/);
  assert.equal(formatNextAutomationRun(new Date(2026, 7, 14, 12, 0), opts), "Next tomorrow");
  assert.equal(formatNextAutomationRun(new Date(2026, 7, 13, 20, 19), opts), "Next today at 20:19");
  assert.equal(compactCronSummary("0 12 * * *", "en-GB"), "Daily at 12:00");
  assert.equal(compactCronSummary("0 9 * * 1", "en-GB"), "Every Monday at 9:00");
  assert.equal(compactCronSummary("30 8 1 * *", "en-GB"), "Monthly on day 1 at 8:30");
  assert.equal(compactCronSummary("*/15 * * * *", "en-GB"), null);
});

test("run history separates active, parked, dead-letter and terminal runs", () => {
  const run = (status: AccountAutomationRun["status"]): AccountAutomationRun => ({
    id: `run-${status}`, triggerKind: "manual", status, title: status, createdAt: "2026-08-13T00:00:00Z",
  });
  for (const [status, category] of [["pending", "active"], ["running", "active"], ["waiting", "parked"], ["needs_attention", "parked"], ["failed", "dead_letter"], ["succeeded", "all"], ["cancelled", "all"]] as const) {
    assert.equal(runHistoryCategory(run(status)), category, status);
  }
});

test("session list: status, attention order and date groups", () => {
  assert.equal(statusClass({ status: "working" }), "working");
  assert.equal(statusLabel({ status: "failed" }), "Last turn failed");
  assert.equal(isUnseen({ status: "idle", finishedAt: 20, lastSeenAt: 10 }), true);
  assert.equal(attentionRank({ status: "idle", finishedAt: 20, lastSeenAt: 10 }), 1);
  assert.equal(attentionRank({ status: "failed" }), 2);
  assert.equal(attentionRank({ status: "needs_action" }), 3);
  const now = new Date(2026, 7, 13, 15, 0);
  assert.equal(sessionDateGroup(new Date(2026, 7, 13, 1, 0), now), "Today");
  assert.equal(sessionDateGroup(new Date(2026, 7, 12, 23, 0), now), "Yesterday");
  assert.equal(sessionDateGroup(new Date(2026, 7, 8, 12, 0), now), "Previous 7 days");
  assert.equal(sessionDateGroup(new Date(2026, 7, 1, 12, 0), now), "Older");
  assert.equal(sessionDateGroup(undefined, now), "Older");
  assert.equal(sessionDateGroup("not-a-date", now), "Older");
});

test("chat scroll restores distance from the bottom, or the latest content when pinned", () => {
  const memory = captureChatScroll({ scrollHeight: 1_000, scrollTop: 600, clientHeight: 300 }, false, 60);
  assert.deepEqual(memory, { distanceFromBottom: 100, pinned: false, limit: 60 });
  assert.equal(restoredChatScrollTop({ scrollHeight: 1_500, scrollTop: 0, clientHeight: 300 }, memory), 1_100);
  assert.equal(restoredChatScrollTop({ scrollHeight: 1_500, scrollTop: 0, clientHeight: 300 }, { ...memory, pinned: true }), 1_500);
  assert.equal(restoredChatScrollTop({ scrollHeight: 200, scrollTop: 0, clientHeight: 300 }, memory), 0);
});

test("review prompts name the file, cap long change sets and list only failed checks", () => {
  const file: ReviewPromptFile = { path: "src/auth.ts", status: "modified", added: 8, removed: 3 };
  assert.match(buildFileReviewPrompt(file), /`src\/auth\.ts` \(modified, \+8\/−3\)/);
  const files = Array.from({ length: 32 }, (_, index): ReviewPromptFile => ({ path: `src/file-${index}.ts`, status: "modified", added: index, removed: 0 }));
  const set = buildChangeSetReviewPrompt(files, [{ name: "typecheck", status: "passed" }, { name: "unit tests", status: "failed" }]);
  assert.match(set, /`src\/file-0\.ts`/);
  assert.match(set, /and 2 more changed files/);
  assert.doesNotMatch(set, /file-30/);
  assert.match(set, /Failed checks to investigate: unit tests/);
  assert.doesNotMatch(set, /Failed checks to investigate: typecheck/);
});

test("native session links accept only same-origin session/run paths", () => {
  const origin = "https://app.example";
  assert.deepEqual(nativeSessionLink(`${origin}/sessions/abc-123?node=node_1`, origin), { path: "/sessions/abc-123", node: "node_1" });
  assert.deepEqual(nativeSessionLink(`${origin}/runs/run_1`, origin), { path: "/runs/run_1", node: null });
  for (const path of ["/auth/device/start", "/sessions/new", "/sessions/a/b", "/sessions/a?token=secret", "/sessions/a?node=a&node=b", "/sessions/a#secret", "/sessions/a?node=", "/sessions/a%2fb", "/runs/a?node=b"]) {
    assert.equal(nativeSessionLink(origin + path, origin), null, path);
  }
  for (const url of ["http://app.example/sessions/a", "https://evil.example/sessions/a", "https://app.example.evil/sessions/a", "https://user:pass@app.example/sessions/a", "javascript:alert(1)", "/sessions/a"]) {
    assert.equal(nativeSessionLink(url, origin), null, url);
  }
});

test("a standby copy offers Continue here only while its owner is offline", () => {
  const nodes = [{ id: "mac", name: "Mac", online: false }, { id: "box", name: "Box", online: true }];
  assert.deepEqual(standbyCopyOf("replica:mac", nodes), { ownerId: "mac", ownerName: "Mac", ownerOnline: false });
  assert.equal(standbyCopyOf("replica:box", nodes)?.ownerOnline, true, "a live owner is where the session should be opened");
  assert.equal(standbyCopyOf("promoted:mac", nodes), undefined, "once promoted it is this machine's own session");
  assert.equal(standbyCopyOf("repo:acme/app", nodes), undefined);
});
