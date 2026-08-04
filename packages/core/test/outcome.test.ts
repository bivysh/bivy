import { describe, expect, it } from "vitest";
import { deriveRunOutcome } from "../src/outcome.js";

describe("deriveRunOutcome", () => {
  it("never treats process completion alone as success", () => {
    expect(deriveRunOutcome({ status: "succeeded" }).kind).toBe("needs_review");
  });

  it("prioritizes deterministic check failure over artifacts", () => {
    expect(deriveRunOutcome({ status: "succeeded", output: { prUrl: "https://example.test/pr/1" }, checks: [{ name: "test", status: "failed" }] }).kind).toBe("checks_failed");
  });

  it("recognizes reviewable artifacts and explicit no-change outcomes", () => {
    expect(deriveRunOutcome({ status: "succeeded", output: { prUrl: "https://example.test/pr/1" } }).kind).toBe("pr_open");
    expect(deriveRunOutcome({ status: "done", output: { branch: "bivy/work" } }).kind).toBe("changes_ready");
    expect(deriveRunOutcome({ status: "succeeded", events: [{ at: new Date().toISOString(), kind: "completed", summary: "Run completed with no file changes." }] }).kind).toBe("no_changes");
  });

  it("represents waiting/rate-limited work separately from running", () => {
    // Explicit waiting status.
    expect(deriveRunOutcome({ status: "waiting" }).kind).toBe("waiting");
    // Nominally running, but the latest signal is a rate-limit → waiting, not running.
    expect(deriveRunOutcome({
      status: "running",
      events: [
        { at: "1", kind: "attempt_started", summary: "started" },
        { at: "2", kind: "rate_limited", summary: "Provider rate limit; backing off." },
      ],
    } as never).kind).toBe("waiting");
    // A plain running item is still running, and waiting is non-terminal.
    expect(deriveRunOutcome({ status: "running" }).kind).toBe("running");
    expect(deriveRunOutcome({ status: "waiting" }).terminal).toBe(false);
    // Once it resumes work, it is running again, not stuck at waiting.
    expect(deriveRunOutcome({
      status: "running",
      events: [
        { at: "1", kind: "rate_limited", summary: "backing off" },
        { at: "2", kind: "attempt_started", summary: "resumed" },
      ],
    } as never).kind).toBe("running");
  });

  it("distinguishes timeout and ordinary agent failure", () => {
    expect(deriveRunOutcome({ status: "failed", output: { failure: "Agent turn timed out after 60 minutes" } }).kind).toBe("timed_out");
    expect(deriveRunOutcome({ status: "failed", output: { failure: "runtime exited" } }).kind).toBe("agent_failed");
  });
});
