// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { test } from "node:test";
import type { GithubQueueItem } from "../packages/core/src/account.js";
import { classifySource, indexSessionSources } from "../packages/web/src/sessionSource.js";

function run(over: Partial<GithubQueueItem> = {}): GithubQueueItem {
  return {
    id: "run", source: "schedule", status: "succeeded", label: "bivy",
    title: "Continuous Agent Improvement", createdAt: "2026-08-04T00:00:00Z",
    targetKind: "new_session", output: { sessionId: "session" }, ...over,
  };
}

test("repo-backed scheduled sessions use their creating trigger, preserving repo metadata", () => {
  const sessions = ["CI failed: CI #1947", "CI failed: CI #1946", "Continuous Agent Improvement"]
    .map((name, i) => ({ sessionId: `s${i}`, name, source: "repo:bivysh/bivy" }));
  const sources = indexSessionSources(sessions.map((s) => run({ id: s.sessionId, title: s.name, output: { sessionId: s.sessionId } })));
  for (const s of sessions) {
    assert.deepEqual(sources.get(s.sessionId) ?? classifySource(s.source), {
      kind: "schedule", label: "Scheduled run", automation: true,
    });
    assert.equal(s.source, "repo:bivysh/bivy");
  }
});

test("all automation origins come from provenance, never the session title", () => {
  for (const [source, kind] of [
    ["schedule", "schedule"], ["manual", "manual"], ["automation:hook", "webhook"],
    ["slack", "slack"], ["linear:issue", "linear"],
    ["github:issue", "github-issue"], ["github:comment", "github-mention"],
  ]) {
    assert.equal(indexSessionSources([run({ source })]).get("session")?.kind, kind);
  }
  assert.equal(classifySource("repo:bivysh/bivy").kind, "app");
  assert.equal(classifySource("queue:schedule").kind, "schedule");
  assert.equal(classifySource("cli").kind, "cli");
});

test("a follow-up does not replace the creating trigger or relabel a manual session", () => {
  const followUp = run({ source: "manual", targetKind: "existing_session", targetSessionId: "session", createdAt: "2026-08-05T00:00:00Z" });
  assert.equal(indexSessionSources([followUp, run()]).get("session")?.kind, "schedule");
  assert.equal(indexSessionSources([followUp]).size, 0);
  assert.equal(indexSessionSources([run({ targetKind: undefined, targetSessionId: "session" })]).size, 0);
});

test("origin is stable across queue ordering; legacy creating runs work", () => {
  const earliest = run({ targetKind: undefined });
  const later = run({ id: "later", source: "manual", createdAt: "2026-08-05T00:00:00Z" });
  for (const queue of [[earliest, later], [later, earliest]]) {
    assert.equal(indexSessionSources(queue).get("session")?.kind, "schedule");
  }
});

test("missing/loading evidence and runs without sessions leave source-tag fallback intact", () => {
  for (const queue of [undefined, null, [], [run({ output: undefined })]]) {
    assert.equal(indexSessionSources(queue).size, 0);
  }
});
