// SPDX-License-Identifier: AGPL-3.0-only
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { NodeConnectionCoordinator } from "../packages/web/src/store/coordinators/node-connection-coordinator.js";
import { CredentialsModelsCoordinator } from "../packages/web/src/store/coordinators/credentials-models-coordinator.js";
import { SessionOrchestrator } from "../packages/web/src/store/coordinators/session-orchestrator.js";

test("node coordinator owns the complete switch ordering", () => {
  const events: string[] = [];
  let current = "old";
  const coordinator = new NodeConnectionCoordinator({
    facts: () => ({ direct: false, solo: false, signedIn: true, currentNodeId: current }),
    status: () => "online",
    closeTransport: () => events.push("close"),
    setCurrentNode: (id) => { current = id; events.push(`identity:${id}`); },
    resetSession: () => events.push("reset"),
    seedSessions: () => events.push("seed"),
    rebuildTransport: () => events.push("build"),
    setStatus: (status) => events.push(status),
    connectTransport: () => events.push("connect"),
    refreshNodes: () => events.push("nodes"),
    refreshAccountSessions: () => events.push("sessions"),
    waitForOnline: async () => {},
    listProviders: () => events.push("providers"),
  });
  assert.equal(coordinator.switchNode("new"), true);
  assert.deepEqual(events, ["close", "identity:new", "reset", "seed", "build", "connecting", "connect", "sessions"]);
});

test("credentials coordinator owns direct-mode probe policy", async () => {
  let sent = false;
  const coordinator = new CredentialsModelsCoordinator({
    send: () => { sent = true; },
    awaitAck: async () => { throw new Error("must not send"); },
    rememberModel: () => {},
    selectModelLocally: () => {},
    isDirect: () => true,
    now: () => 42,
  });
  assert.deepEqual(await coordinator.testCredential("openai", "default"), { ok: false, at: 42, reason: "not_supported" });
  assert.equal(sent, false);
});

test("session coordinator correlates and completes a local fork", async () => {
  let command: any;
  let opened = "";
  const coordinator = new SessionOrchestrator({
    send: () => {},
    sendRequest: (value) => { command = value; },
    createRequestId: () => "request-1",
    createClientMessageId: () => "message-1",
    currentNodeId: () => "node-1",
    isDirect: () => false,
    sessionRuntime: () => "claude",
    switchNode: () => {},
    waitForOnline: async () => {},
    openSession: (id) => { opened = id; },
    addUserMessage: () => {},
    transcriptUrl: () => "https://app/sessions/source",
    refreshAccountSessions: () => {},
  });
  const result = coordinator.fork("source", {});
  assert.equal(command.kind, "session.fork.local");
  assert.equal(coordinator.handleEvent({ type: "session.fork.done", requestId: "request-1", sessionId: "forked", fidelity: "full" } as any), true);
  assert.deepEqual(await result, { sessionId: "forked", fidelity: "full", missing: [] });
  assert.equal(opened, "forked");
});

test("AppController keeps public compatibility while workflow decisions live outside it", async () => {
  const source = await readFile(new URL("../packages/web/src/store/controller.ts", import.meta.url), "utf8");
  assert.match(source, /switchNode\(nodeId: string\): void \{\s*this\.nodeCoordinator\.switchNode\(nodeId\);/);
  assert.match(source, /return this\.sessionCoordinator\.fork\(sourceSessionId, opts\)/);
  assert.match(source, /return this\.credentialsModelsCoordinator\.testCredential\(provider, label\)/);
  assert.doesNotMatch(source, /kind: "session\.fork\.export"/);
  assert.doesNotMatch(source, /kind: "models\.custom\.verify"/);
});
