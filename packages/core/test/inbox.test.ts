// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "vitest";
import { buildInboxItems, dedupeInboxItems, inboxItemId, isInboxAdvert, type InboxItem } from "../src/inbox.js";
import type { AccountNode, GithubQueueItem } from "../src/account.js";
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
