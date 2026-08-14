// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { buildInboxItems, dedupeInboxItems, inboxItemId, isInboxAdvert, type InboxItem } from "../src/inbox.js";
import type { AccountAutomationRun, AccountNode, GithubQueueItem } from "../src/account.js";
import type { ApprovalRequest, SessionSummary, UserQuestionRequest } from "../src/store.js";

function item(updatedAt: string, title = "old"): InboxItem {
  return {
    id: inboxItemId("session", "s1", "condition-1"),
    kind: "approval", severity: "warning", source: "session", state: "unresolved",
    sessionId: "s1", title, createdAt: "2026-01-01T00:00:00.000Z", updatedAt,
  };
}

describe("global inbox normalization", () => {
  it("uses a deterministic identity for one unresolved condition", () => {
    expect(inboxItemId("session", "s1", "a1")).toBe("session:s1:a1");
  });

  it("deduplicates repeated adverts and keeps the newest projection", () => {
    const result = dedupeInboxItems([
      item("2026-01-01T00:00:01.000Z"),
      item("2026-01-01T00:00:02.000Z", "new"),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.title).toBe("new");
  });

  it("accepts only the bounded content-free advert vocabulary", () => {
    expect(isInboxAdvert({ id: "a1", kind: "approval", severity: "warning", createdAt: "2026-01-01T00:00:00Z" })).toBe(true);
    expect(isInboxAdvert({ id: "a1", kind: "tool-body", severity: "warning", createdAt: "2026-01-01T00:00:00Z" })).toBe(false);
  });
});

describe("buildInboxItems", () => {
  const NOW = Date.parse("2026-01-01T00:10:00.000Z");

  function session(over: Partial<SessionSummary> = {}): SessionSummary {
    return { sessionId: "s1", name: "fix the thing", nodeId: "node-a", updatedAt: NOW, ...over };
  }

  it("surfaces a pending approval on one node while another node is active — no session filter is applied", () => {
    const sessions = [session({ sessionId: "s1", nodeId: "node-a" }), session({ sessionId: "s2", nodeId: "node-b", name: "unrelated" })];
    const approval: ApprovalRequest = { id: "appr-1", sessionId: "s1", tool: "bash", risk: "high", createdAt: NOW };
    const items = buildInboxItems({ sessions, approvals: [approval], questions: [], nodes: [], queue: [], now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "approval", sessionId: "s1", nodeId: "node-a", source: "session" });
  });

  it("shows a failed automation session and an unresolved question exactly once each", () => {
    const sessions = [
      session({
        sessionId: "s1",
        source: "issue:#12",
        attention: [{ id: "last-failure", kind: "automation", severity: "error", createdAt: "2026-01-01T00:05:00.000Z" }],
      }),
    ];
    const question: UserQuestionRequest = {
      id: "q1", sessionId: "s2",
      questions: [{ question: "Which branch?", header: "Branch", options: [{ label: "main" }] }],
      createdAt: NOW,
    };
    const items = buildInboxItems({ sessions, approvals: [], questions: [question], nodes: [], queue: [], now: NOW });
    expect(items).toHaveLength(2);
    const automationItems = items.filter((i) => i.kind === "automation");
    const questionItems = items.filter((i) => i.kind === "question");
    expect(automationItems).toHaveLength(1);
    expect(automationItems[0]).toMatchObject({ source: "automation", sessionId: "s1", runId: "s1" });
    expect(questionItems).toHaveLength(1);
    expect(questionItems[0]).toMatchObject({ sessionId: "s2", targetId: "q1" });
  });

  it("retires a failure advert after its session is opened, but keeps blocking questions", () => {
    const failedAt = "2026-01-01T00:05:00.000Z";
    const viewed = session({
      lastSeenAt: Date.parse("2026-01-01T00:06:00.000Z"),
      attention: [
        { id: "last-failure", kind: "session", severity: "error", createdAt: failedAt },
        { id: "q1", kind: "question", severity: "warning", createdAt: failedAt },
      ],
    });
    const items = buildInboxItems({ sessions: [viewed], approvals: [], questions: [], nodes: [], queue: [], now: NOW });
    expect(items.map((i) => i.kind)).toEqual(["question"]);
  });

  it("never double-counts one unresolved condition advertised by both the account index and a live push", () => {
    const sessions = [
      session({
        sessionId: "s1",
        attention: [{ id: "appr-1", kind: "approval", severity: "warning", createdAt: "2026-01-01T00:00:00.000Z" }],
      }),
    ];
    const approval: ApprovalRequest = { id: "appr-1", sessionId: "s1", risk: "medium", createdAt: NOW };
    const items = buildInboxItems({ sessions, approvals: [approval], questions: [], nodes: [], queue: [], now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe(inboxItemId("session", "s1", "appr-1"));
  });

  it("marks a condition stale when its owning node is offline, and degrades safely without crashing", () => {
    const sessions = [
      session({
        sessionId: "s1", nodeId: "node-a",
        attention: [{ id: "appr-1", kind: "approval", severity: "warning", createdAt: "2026-01-01T00:00:00.000Z" }],
      }),
    ];
    const offlineNode: AccountNode = { id: "node-a", name: "laptop", online: false };
    const items = buildInboxItems({ sessions, approvals: [], questions: [], nodes: [offlineNode], queue: [], now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]?.stale).toBe(true);
  });

  it("only surfaces queue items still awaiting manual assignment", () => {
    const pending: GithubQueueItem = { id: "q1", source: "github:issue", status: "pending", label: "bivy/main", title: "Fix bug", createdAt: "2026-01-01T00:00:00.000Z" };
    const claimed: GithubQueueItem = { id: "q2", source: "github:issue", status: "claimed", label: "bivy/main", title: "Already picked up", createdAt: "2026-01-01T00:00:00.000Z" };
    const items = buildInboxItems({ sessions: [], approvals: [], questions: [], nodes: [], queue: [pending, claimed], now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "queue", queueItemId: "q1" });
  });

  it("keeps a recent reviewable outcome until its session is opened after completion", () => {
    const completedAt = "2026-01-01T00:08:00.000Z";
    const completed: GithubQueueItem = {
      id: "q-done", source: "github:issue", status: "succeeded", label: "bivy/main", title: "Fix bug",
      createdAt: "2026-01-01T00:00:00.000Z", completedAt,
      output: { sessionId: "s-done", prUrl: "https://github.test/pr/1" },
    };
    const unseen = buildInboxItems({
      sessions: [session({ sessionId: "s-done", lastSeenAt: Date.parse("2026-01-01T00:07:00.000Z") })],
      approvals: [], questions: [], nodes: [], queue: [completed], now: NOW,
    });
    expect(unseen).toHaveLength(1);
    expect(unseen[0]).toMatchObject({ kind: "outcome", sessionId: "s-done", title: "PR open — review outcome" });

    const reviewed = buildInboxItems({
      sessions: [session({ sessionId: "s-done", lastSeenAt: Date.parse(completedAt) })],
      approvals: [], questions: [], nodes: [], queue: [completed], now: NOW,
    });
    expect(reviewed).toHaveLength(0);
  });

  it("surfaces an automation run that needs attention or failed, keyed by run id, and ignores healthy runs", () => {
    const runs: AccountAutomationRun[] = [
      { id: "run-1", triggerKind: "github", status: "needs_attention", title: "Nightly deploy", createdAt: "2026-01-01T00:03:00.000Z", output: { sessionId: "s9" } },
      { id: "run-2", triggerKind: "schedule", status: "failed", title: "Sync issues", createdAt: "2026-01-01T00:04:00.000Z", completedAt: "2026-01-01T00:06:00.000Z" },
      { id: "run-3", triggerKind: "github", status: "succeeded", title: "All good", createdAt: "2026-01-01T00:05:00.000Z" },
    ];
    const sessions = [session({ sessionId: "s9", nodeId: "node-a" })];
    const items = buildInboxItems({ sessions, approvals: [], questions: [], nodes: [], queue: [], runs, now: NOW });
    const automation = items.filter((i) => i.kind === "automation");
    expect(automation).toHaveLength(2);
    expect(automation.find((i) => i.runId === "run-1")).toMatchObject({ source: "automation", severity: "warning", sessionId: "s9", nodeId: "node-a" });
    expect(automation.find((i) => i.runId === "run-2")).toMatchObject({ source: "automation", severity: "error", id: inboxItemId("automation", "run-2", "failed") });
    expect(automation.some((i) => i.runId === "run-3")).toBe(false);
  });

  it("retires a failed automation run after its linked session is opened", () => {
    const completedAt = "2026-01-01T00:06:00.000Z";
    const runs: AccountAutomationRun[] = [
      { id: "run-f", triggerKind: "github", status: "failed", title: "Fix", createdAt: "2026-01-01T00:05:00.000Z", completedAt, output: { sessionId: "s9" } },
    ];
    const sessions = [session({ sessionId: "s9", lastSeenAt: Date.parse(completedAt) })];
    const items = buildInboxItems({ sessions, approvals: [], questions: [], nodes: [], queue: [], runs, now: NOW });
    expect(items).toEqual([]);
  });

  it("lets a real automation run supersede a session's source-derived failure advert — counted once", () => {
    const sessions = [
      session({
        sessionId: "s9", nodeId: "node-a", source: "issue:#7",
        attention: [{ id: "last-failure", kind: "automation", severity: "error", createdAt: "2026-01-01T00:05:00.000Z" }],
      }),
    ];
    const runs: AccountAutomationRun[] = [
      { id: "run-9", triggerKind: "github", status: "failed", title: "Fix #7", createdAt: "2026-01-01T00:05:30.000Z", output: { sessionId: "s9" } },
    ];
    const items = buildInboxItems({ sessions, approvals: [], questions: [], nodes: [], queue: [], runs, now: NOW });
    const automation = items.filter((i) => i.kind === "automation");
    expect(automation).toHaveLength(1);
    expect(automation[0]).toMatchObject({ runId: "run-9", sessionId: "s9" });
  });

  it("flags an expired provider auth as blocking work, but not one still valid or unconfigured", () => {
    const node: AccountNode = {
      id: "node-a", name: "laptop",
      providers: [
        { id: "anthropic", name: "Anthropic", configured: true, expiresAt: NOW - 1000 }, // expired
        { id: "openai", name: "OpenAI", configured: true, expiresAt: NOW + 100_000 }, // still valid
        { id: "google", name: "Google", configured: false }, // never configured
      ],
    };
    const items = buildInboxItems({ sessions: [], approvals: [], questions: [], nodes: [node], queue: [], now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "provider", providerId: "anthropic", nodeId: "node-a" });
  });
});
