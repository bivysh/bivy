// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Certification matrix. These are substrate faults, not model-quality
// tests: the identical delivery/reconnect/attention/handoff contract is run for
// both recommended adapters. Live provider calls remain separately opt-in.

import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionStore } from "../packages/core/src/store.js";
import { ApprovalManager } from "../src/approval.js";
import { QuestionManager } from "../src/question.js";
import { listRuntimes } from "../src/runtime/index.js";
import { createSessionNewDedupe } from "../src/session/session-new-dedupe.js";

const RECOMMENDED = ["claude-code-sdk", "codex-approvals"] as const;
const question = {
  question: "Continue with this change?", header: "Continue",
  options: [{ label: "Continue" }, { label: "Stop" }],
};

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for fault-matrix state");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

for (const runtimeId of RECOMMENDED) {
  test(`${runtimeId}: remote continuity fault matrix`, async () => {
    const runtime = listRuntimes().find((candidate) => candidate.id === runtimeId);
    assert.ok(runtime, "recommended adapter remains registered");
    const capabilities = runtime.capabilities as Record<string, unknown>;
    assert.equal(capabilities.resume, true, "matrix requires native resume");
    assert.equal(capabilities.toolInterception, true, "matrix requires governed attention actions");

    // Lost acknowledgement: replaying the same client id joins the first turn.
    const delivery = createSessionNewDedupe<void>();
    let turns = 0;
    const deliver = () => delivery.run(`${runtimeId}:message-1`, async () => { turns++; });
    await Promise.all([deliver(), deliver()]);
    assert.equal(turns, 1, "reconnect retry never duplicates a prompt");

    // Mid-stream disconnect: fresh authoritative history settles the stuck turn
    // and retains the exact runtime/session identity.
    const firstClient = new SessionStore();
    firstClient.apply({ type: "sessions.list", sessions: [{ id: "session-1", name: "Remote task", runtimeId }] });
    firstClient.beginOpen("session-1");
    firstClient.apply({ type: "session.event", sessionId: "session-1", event: { type: "agent_start" } });
    firstClient.markStreamInterrupted();
    firstClient.apply({
      type: "session.history", sessionId: "session-1", runtimeId, isStreaming: false,
      messages: [{ role: "user", content: "do it" }, { role: "assistant", content: [{ type: "text", text: "done" }] }],
    } as never);
    assert.equal(firstClient.getState().activeSession.working, false);
    assert.equal(firstClient.getState().activeSession.activeRuntimeId, runtimeId);
    assert.ok(firstClient.getState().activeSession.transcript.some((entry) => entry.text === "done"));

    // Approval and question survive a client disappearance because their
    // managers remain node-owned and listable for replay on the next client.
    const approvals = new ApprovalManager();
    const approval = approvals.request({ sessionId: "session-1", toolName: "shell", toolInput: {}, reason: "writes files", timeoutMs: 2_000 });
    await waitFor(() => approvals.list().some((entry) => entry.status === "pending"));
    const approvalId = approvals.list().find((entry) => entry.status === "pending")!.id;
    assert.equal(approvals.resolve(approvalId, true), true);
    assert.equal(await approval, true);

    const questions = new QuestionManager();
    const answer = questions.request({ sessionId: "session-1", questions: [question], timeoutMs: 2_000 });
    await waitFor(() => questions.list().length === 1);
    const pendingQuestion = questions.list()[0]!;
    assert.equal(questions.resolve(pendingQuestion.id, { behavior: "completed", answers: { [question.question]: "Continue" } }), true);
    assert.equal((await answer).behavior, "completed");

    // Multi-client handoff: a second client reconstructs the same durable
    // Session without altering or reopening the first client's turn.
    const secondClient = new SessionStore();
    secondClient.apply({ type: "sessions.list", sessions: [{ id: "session-1", name: "Remote task", runtimeId }] });
    secondClient.beginOpen("session-1");
    secondClient.apply({
      type: "session.history", sessionId: "session-1", runtimeId, isStreaming: false,
      messages: [{ role: "user", content: "do it" }, { role: "assistant", content: [{ type: "text", text: "done" }] }],
    } as never);
    assert.equal(secondClient.getState().activeSession.activeSessionId, "session-1");
    assert.equal(secondClient.getState().activeSession.activeRuntimeId, runtimeId);
    assert.deepEqual(
      secondClient.getState().activeSession.transcript.map((entry) => [entry.role, entry.text]),
      firstClient.getState().activeSession.transcript.map((entry) => [entry.role, entry.text]),
    );

    // Stop/teardown settles every node-owned attention wait immediately.
    const parkedApproval = approvals.request({ sessionId: "session-stop", toolName: "shell", toolInput: {}, reason: "stop test", timeoutMs: 2_000 });
    const parkedQuestion = questions.request({ sessionId: "session-stop", questions: [question], timeoutMs: 2_000 });
    await waitFor(() => approvals.list().some((entry) => entry.sessionId === "session-stop" && entry.status === "pending") && questions.list().some((entry) => entry.sessionId === "session-stop"));
    approvals.cancelForSession("session-stop");
    questions.cancelForSession("session-stop");
    assert.equal(await parkedApproval, false);
    assert.equal((await parkedQuestion).behavior, "cancelled");
  });
}

