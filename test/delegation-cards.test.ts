// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { strict as assert } from "node:assert";
import test from "node:test";
import { delegationCard } from "../src/session/delegation-cards.js";
import { SessionStore } from "../packages/core/src/store.js";
import { nestDelegatedSessions } from "../packages/web/src/sessionNesting.js";

const run = (status: string, extra: Record<string, unknown> = {}) => ({ runId: "r1", status, provenance: { parentSessionId: "p", depth: 1 }, ...extra }) as any;

test("a delegation card keeps what only the start knew and folds in each status", () => {
  const started = delegationCard(undefined, run("pending"), { instructions: "Review the auth diff\nwith care", agent: "codex-approvals", machine: "linux-box", nodeId: "n2", group: "g1" });
  assert.deepEqual(started, { id: "r1", status: "pending", task: "Review the auth diff", agent: "codex-approvals", machine: "linux-box", nodeId: "n2", group: "g1" });
  const running = delegationCard(started, run("running", { references: { sessionId: "child" } }));
  assert.equal(running.childSessionId, "child");
  assert.equal(running.machine, "linux-box", "later statuses keep the target");
  const done = delegationCard(running, run("succeeded", { answer: "Looks good.", references: { branch: "review/auth" } }));
  assert.deepEqual([done.status, done.answer, done.branch, done.childSessionId], ["succeeded", "Looks good.", "review/auth", "child"]);
});

test("a live delegation event updates its card in place", () => {
  const store = new SessionStore();
  store.beginOpen("p");
  store.apply({ type: "session.history", sessionId: "p", messages: [] } as any);
  for (const status of ["running", "succeeded"]) {
    store.apply({ type: "session.event", sessionId: "p", event: { type: "delegation", delegation: { id: "r1", status, task: "t" } } } as any);
  }
  const cards = store.getState().activeSession.transcript.filter((entry) => entry.delegation);
  assert.deepEqual(cards.map((entry) => entry.delegation?.status), ["succeeded"]);
});

test("delegated children list under their parent; an unlisted parent leaves the child in place", () => {
  const rows = [
    { sessionId: "child-a", delegatedFrom: { sessionId: "parent" } },
    { sessionId: "other" },
    { sessionId: "parent" },
    { sessionId: "orphan", delegatedFrom: { sessionId: "elsewhere" } },
  ];
  assert.deepEqual(nestDelegatedSessions(rows).map((row) => `${row.sessionId}${row.nestedUnder ? "<" : ""}`), ["other", "parent", "child-a<", "orphan"]);
});
