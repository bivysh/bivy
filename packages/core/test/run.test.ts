import { describe, expect, it } from "vitest";
import type { AccountAutomationRun, GithubQueueItem } from "../src/account.js";
import {
  parseRunRoute,
  runFromAutomationRun,
  runFromQueueItem,
  runRoutePath,
} from "../src/run.js";

describe("canonical Run projection", () => {
  it("projects both legacy Run shapes to the same canonical Run", () => {
    // The same logical Run seen through the two legacy records. Only the fields
    // both records can express are compared, but the outcome/lifecycle/action
    // derivation must be identical.
    const common = {
      id: "run_1",
      status: "succeeded" as const,
      title: "Fix flaky test",
      triggerKind: "manual",
      definitionId: "auto_9",
      attempt: 2,
      createdAt: "2026-08-12T10:00:00.000Z",
      startedAt: "2026-08-12T10:00:05.000Z",
      completedAt: "2026-08-12T10:03:05.000Z",
      runtimeId: "claude-code",
      model: "claude-opus-4-8",
      approvalMode: "risky" as const,
      sandbox: "workspace-write" as const,
      checks: [{ name: "test", status: "passed" as const }],
      events: [{ at: "2026-08-12T10:00:05.000Z", kind: "attempt_started" as const, summary: "started" }],
      output: { sessionId: "sess_7", prUrl: "https://example.test/pr/3" },
    };
    const queueItem: GithubQueueItem = { ...common, source: "manual", label: "bivy/x" };
    const automationRun: AccountAutomationRun = { ...common, triggerKind: "manual" };

    const fromQueue = runFromQueueItem(queueItem);
    const fromRun = runFromAutomationRun(automationRun);

    // Origin diagnostics differ; everything customer-facing must match.
    expect(fromQueue.origin.projection).toBe("queue_item");
    expect(fromRun.origin.projection).toBe("automation_run");
    const { origin: _q, ...queueRest } = fromQueue;
    const { origin: _r, ...runRest } = fromRun;
    expect(queueRest).toEqual(runRest);

    expect(fromQueue.outcome.kind).toBe("pr_open");
    expect(fromQueue.lifecycle).toBe("finished");
    expect(fromQueue.attempt).toBe(2);
    expect(fromQueue.sessionId).toBe("sess_7");
    expect(fromQueue.durationMs).toBe(180_000);
    expect(fromQueue.references.pullRequest).toBe("https://example.test/pr/3");
    expect(fromQueue.source).toEqual({ kind: "manual", automationId: "auto_9" });
  });

  it("preserves missing/ambiguous evidence as Needs review, never success", () => {
    const bare: GithubQueueItem = {
      id: "run_2",
      source: "manual",
      status: "succeeded",
      label: "bivy/y",
      title: "Investigate",
      createdAt: "2026-08-12T10:00:00.000Z",
    };
    const run = runFromQueueItem(bare);
    expect(run.outcome.kind).toBe("needs_review");
    expect(run.lifecycle).toBe("finished");
    // No manufactured session, machine, duration, or references.
    expect(run.sessionId).toBeUndefined();
    expect(run.machine).toBeUndefined();
    expect(run.durationMs).toBeUndefined();
    expect(run.references).toEqual({});
  });

  it("carries Machine identity only when known and resolves a name via context", () => {
    const item: GithubQueueItem = {
      id: "run_3", source: "manual", status: "running", label: "l", title: "t",
      createdAt: "2026-08-12T10:00:00.000Z", claimedByNodeId: "node_42",
    };
    expect(runFromQueueItem(item).machine).toEqual({ id: "node_42" });
    expect(runFromQueueItem(item, { resolveMachineName: (id) => (id === "node_42" ? "Petter's laptop" : undefined) }).machine)
      .toEqual({ id: "node_42", name: "Petter's laptop" });
    // Unknown machine stays unknown, never invented.
    const noMachine: GithubQueueItem = { ...item, claimedByNodeId: undefined };
    expect(runFromQueueItem(noMachine).machine).toBeUndefined();
  });

  it("uses the continuation target session id when no produced session exists", () => {
    const item: GithubQueueItem = {
      id: "run_4", source: "schedule", status: "running", label: "l", title: "t",
      createdAt: "2026-08-12T10:00:00.000Z", targetKind: "existing_session", targetSessionId: "sess_cont",
    };
    expect(runFromQueueItem(item).sessionId).toBe("sess_cont");
  });

  describe("recovery and cancellation actions", () => {
    const base = (status: GithubQueueItem["status"], extra: Partial<GithubQueueItem> = {}): GithubQueueItem => ({
      id: "r", source: "manual", status, label: "l", title: "t",
      createdAt: "2026-08-12T10:00:00.000Z", ...extra,
    });

    it("offers Cancel only for cancellable durable states", () => {
      const cancellable: GithubQueueItem["status"][] = ["pending", "claimed", "running", "waiting", "needs_attention"];
      for (const status of cancellable) {
        expect(runFromQueueItem(base(status)).actions.some((a) => a.kind === "cancel")).toBe(true);
      }
      const terminal: GithubQueueItem["status"][] = ["succeeded", "failed", "cancelled", "done"];
      for (const status of terminal) {
        expect(runFromQueueItem(base(status)).actions.some((a) => a.kind === "cancel")).toBe(false);
      }
    });

    it("offers Retry only for terminal failure outcomes, never after cancellation", () => {
      expect(runFromQueueItem(base("failed", { output: { failure: "runtime exited" } })).actions.some((a) => a.kind === "retry")).toBe(true);
      expect(runFromQueueItem(base("needs_attention")).actions.some((a) => a.kind === "retry")).toBe(false); // still cancellable, not terminal
      expect(runFromQueueItem(base("cancelled")).actions.some((a) => a.kind === "retry")).toBe(false);
      expect(runFromQueueItem(base("succeeded", { output: { prUrl: "https://example.test/pr/1" } })).actions.some((a) => a.kind === "retry")).toBe(false);
      expect(runFromQueueItem(base("failed", { attempt: 2, maxAttempts: 2, output: { failure: "runtime exited" } })).actions.some((a) => a.kind === "retry")).toBe(false);
    });
  });
});

describe("Run route parsing and serialization", () => {
  it("round-trips a run id through the route", () => {
    expect(runRoutePath("run_1")).toBe("/runs/run_1");
    expect(parseRunRoute(runRoutePath("run_1"))).toBe("run_1");
  });

  it("encodes and restores ids that need escaping", () => {
    const id = "github:issue/owner repo#5";
    const path = runRoutePath(id);
    expect(path).not.toContain(" ");
    expect(parseRunRoute(path)).toBe(id);
  });

  it("restores from a full pasted URL with query and hash (cross-device)", () => {
    expect(parseRunRoute("https://app.bivy.sh/runs/run_9?ref=inbox#top")).toBe("run_9");
  });

  it("rejects non-Run paths", () => {
    expect(parseRunRoute("/sessions/abc")).toBeNull();
    expect(parseRunRoute("/runs/")).toBeNull();
    expect(parseRunRoute("")).toBeNull();
    expect(parseRunRoute("/runs/a/b")).toBeNull();
  });
});
