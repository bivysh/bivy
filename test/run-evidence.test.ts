import assert from "node:assert/strict";
import type { GithubQueueItem } from "../packages/core/src/account.js";
import { checkCounts, runDuration, retryReason, artifactRef, recoveryActions, failingCheckNames } from "../packages/web/src/runEvidence.js";

// The outcome-detail surface (C1) derives duration, checks, retry path, and the
// artifact from the already-sanitized run evidence. These are the pure projections
// behind those fields.

let failures = 0;
function check(name: string, fn: () => void) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (error) { failures++; console.error(`FAIL  ${name}\n      ${(error as Error).message}`); }
}

const base = (over: Partial<GithubQueueItem>): GithubQueueItem => ({
  id: "1", source: "github:issue", status: "succeeded", label: "bivy", title: "t", createdAt: "2026-08-04T00:00:00Z", ...over,
} as GithubQueueItem);

check("checkCounts tallies passed/failed/skipped, null when none declared", () => {
  assert.equal(checkCounts(base({ checks: [] })), null);
  assert.equal(checkCounts(base({})), null);
  const c = checkCounts(base({ checks: [
    { name: "test", status: "passed" }, { name: "lint", status: "failed" }, { name: "typecheck", status: "skipped" },
  ] }));
  assert.deepEqual(c, { passed: 1, failed: 1, skipped: 1, total: 3 });
});

check("runDuration formats seconds/minutes/hours; null without both ends", () => {
  assert.equal(runDuration(base({ startedAt: "2026-08-04T00:00:00Z" })), null, "no end → null");
  assert.equal(runDuration(base({ startedAt: "2026-08-04T00:00:00Z", completedAt: "2026-08-04T00:00:38Z" })), "38s");
  assert.equal(runDuration(base({ startedAt: "2026-08-04T00:00:00Z", completedAt: "2026-08-04T00:04:00Z" })), "4m");
  assert.equal(runDuration(base({ startedAt: "2026-08-04T00:00:00Z", completedAt: "2026-08-04T01:03:00Z" })), "1h 3m");
  assert.equal(runDuration(base({ startedAt: "2026-08-04T00:05:00Z", completedAt: "2026-08-04T00:00:00Z" })), null, "negative → null");
});

check("retryReason surfaces the most recent retry/fallback summary", () => {
  assert.equal(retryReason(base({})), null);
  const r = retryReason(base({ events: [
    { at: "1", kind: "attempt_started", summary: "started" },
    { at: "2", kind: "fallback", summary: "fell back after node offline" },
  ] }));
  assert.equal(r, "fell back after node offline");
});

check("artifactRef prefers PR, then artifactUrl, then branch, then commit", () => {
  assert.equal(artifactRef(base({})), null);
  assert.deepEqual(artifactRef(base({ output: { prUrl: "https://x/pr/1", branch: "b", commit: "abcdef1234567" } })), { label: "Pull request", url: "https://x/pr/1" });
  assert.deepEqual(artifactRef(base({ output: { artifactUrl: "https://x/a.zip" } })), { label: "Artifact", url: "https://x/a.zip" });
  assert.deepEqual(artifactRef(base({ output: { branch: "bivy/work" } })), { label: "branch bivy/work" });
  assert.deepEqual(artifactRef(base({ output: { commit: "abcdef1234567890" } })), { label: "commit abcdef123456" });
});

check("failingCheckNames lists only the failed checks", () => {
  assert.deepEqual(failingCheckNames(base({ checks: [
    { name: "test", status: "failed" }, { name: "lint", status: "passed" }, { name: "typecheck", status: "failed" },
  ] })), ["test", "typecheck"]);
  assert.deepEqual(failingCheckNames(base({})), []);
});

check("recoveryActions offers fix/retry/fork on failure — independent of agent prose", () => {
  // A failed check yields fix+retry+fork EVEN when the run 'succeeded' and the
  // agent narrated success — the durable check status drives it, not the prose.
  assert.deepEqual(
    recoveryActions(base({ status: "succeeded", output: { prUrl: "https://x/pr/1" }, checks: [{ name: "test", status: "failed" }], events: [{ at: "1", kind: "completed", summary: "All done, everything passing!" }] })),
    ["fix", "retry", "fork"],
  );
  // A genuine agent failure and a timeout also offer full recovery.
  assert.deepEqual(recoveryActions(base({ status: "failed", output: { failure: "runtime exited" } })), ["fix", "retry", "fork"]);
  assert.deepEqual(recoveryActions(base({ status: "failed", output: { failure: "Agent turn timed out after 60 minutes" } })), ["fix", "retry", "fork"]);
  // A reviewable success offers fork only (iterate on it).
  assert.deepEqual(recoveryActions(base({ status: "succeeded", output: { prUrl: "https://x/pr/1" } })), ["fork"]);
  // Non-terminal and nothing-to-review runs offer nothing.
  assert.deepEqual(recoveryActions(base({ status: "running" })), []);
  assert.deepEqual(recoveryActions(base({ status: "cancelled" })), []);
});

if (failures > 0) { console.error(`\n${failures} run-evidence test(s) failed`); process.exit(1); }
console.log("\nrun-evidence: all tests passed");
