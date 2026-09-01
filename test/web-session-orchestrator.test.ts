// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { test } from "node:test";
import assert from "node:assert/strict";

import { SessionOrchestrator, type SessionOrchestrationDependencies } from "../packages/web/src/store/coordinators/session-orchestrator.js";

function harness() {
  const requests: any[] = [];
  const opens: Array<{ sessionId: string; snapshot: any }> = [];
  let nextId = 0;
  let orchestrator: SessionOrchestrator;
  const deps: SessionOrchestrationDependencies = {
    send: () => {},
    sendRequest: (command) => requests.push(command),
    createRequestId: () => `request-${++nextId}`,
    createClientMessageId: () => `message-${++nextId}`,
    currentNodeId: () => "node-1",
    isDirect: () => true,
    sessionRuntime: () => "claude",
    switchNode: () => {},
    waitForOnline: async () => {},
    openSession: (sessionId, _path, snapshot) => opens.push({ sessionId, snapshot }),
    addUserMessage: () => {},
    transcriptUrl: (sessionId) => `/sessions/${sessionId}`,
    refreshAccountSessions: () => {},
  };
  orchestrator = new SessionOrchestrator(deps);
  return { orchestrator, requests, opens };
}

test("same-agent model fork opens the destination from its correlated snapshot", async () => {
  const { orchestrator, requests, opens } = harness();
  const fork = orchestrator.fork("source-session", {
    sourceAgentId: "claude",
    agentId: "claude",
    model: { provider: "anthropic", id: "claude-opus" },
  });

  assert.equal(requests[0].kind, "session.fork.local");
  assert.deepEqual(requests[0].model, { provider: "anthropic", id: "claude-opus" });
  const done = {
    type: "session.fork.done",
    requestId: requests[0].requestId,
    sessionId: "model-fork",
    runtimeId: "claude",
    agentName: "Claude",
    messages: [],
    fidelity: "full",
    missing: [],
  } as any;
  orchestrator.handleEvent(done);

  await fork;
  assert.deepEqual(opens, [{ sessionId: "model-fork", snapshot: done }]);
});

test("cross-agent fork opens the destination from its correlated snapshot", async () => {
  const { orchestrator, requests, opens } = harness();
  const fork = orchestrator.fork("source-session", {
    sourceAgentId: "claude",
    agentId: "codex",
  });

  assert.equal(requests[0].kind, "session.fork.export");
  orchestrator.handleEvent({
    type: "session.fork.bundle",
    requestId: requests[0].requestId,
    bundle: { record: { runtimeId: "claude" }, normalized: { turns: [] } },
  } as any);
  await Promise.resolve();

  assert.equal(requests[1].kind, "session.fork.import");
  const done = {
    type: "session.fork.done",
    requestId: requests[1].requestId,
    sessionId: "fork-session",
    runtimeId: "codex",
    agentName: "Codex",
    messages: [{ role: "user", content: "Continue here" }],
    fidelity: "replayed",
    missing: [],
  } as any;
  orchestrator.handleEvent(done);

  const result = await fork;
  assert.equal(result.sessionId, "fork-session");
  assert.deepEqual(opens, [{ sessionId: "fork-session", snapshot: done }]);
});
