// SPDX-License-Identifier: AGPL-3.0-only
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { NodeConnectionCoordinator } from "../packages/web/src/store/coordinators/node-connection-coordinator.js";
import { CredentialsModelsCoordinator } from "../packages/web/src/store/coordinators/credentials-models-coordinator.js";
import { SessionOrchestrator } from "../packages/web/src/store/coordinators/session-orchestrator.js";
import { EphemeralCoordinator } from "../packages/web/src/store/coordinators/ephemeral-coordinator.js";
import { AutomationsAccountCoordinator } from "../packages/web/src/store/coordinators/automations-account-coordinator.js";

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
    isOnline: () => true,
    importModelKeys: async () => {},
    accountModelKeys: async () => [],
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

test("session coordinator owns draft creation ordering and first prompt framing", () => {
  const events: string[] = [];
  let pending: any;
  const workflow: any = {
    navigateNew: () => events.push("navigate"), focusComposer: () => events.push("focus"),
    clearPendingPromptAndFollowups: () => events.push("clear"), resetActiveSession: () => events.push("reset"),
    seedDraftDefaults: () => events.push("defaults"), listRuntimes: () => events.push("runtimes"),
    listModels: () => events.push("models"), hasNodeSettings: () => false, getNodeSettings: () => events.push("settings"),
    listRepos: () => events.push("repos"), draftRepo: () => "owner/repo", listBranches: () => events.push("branches"),
    activeSessionId: () => null, isPendingLaunch: () => false, hasPendingPrompt: () => false,
    draftSessionFields: () => ({ repo: "owner/repo", agent: "claude" }), setPendingPrompt: (value: any) => { pending = value; },
    draftEphemeralRunner: () => null, addUserMessage: () => events.push("message"), send: (command: any) => events.push(command.kind),
  };
  const coordinator = new SessionOrchestrator({
    send: () => {}, sendRequest: () => {}, createRequestId: () => "r1", createClientMessageId: () => "m1",
    currentNodeId: () => "n1", isDirect: () => false, sessionRuntime: () => undefined, switchNode: () => {},
    waitForOnline: async () => {}, openSession: () => {}, addUserMessage: () => {}, transcriptUrl: () => "", refreshAccountSessions: () => {},
  }, workflow);
  coordinator.newSession();
  assert.deepEqual(events, ["navigate", "focus", "clear", "reset", "defaults", "runtimes", "models", "settings", "repos", "branches"]);
  events.length = 0;
  coordinator.sendPrompt("  hello  ");
  assert.equal(pending.frame.kind, "session.new");
  assert.equal(pending.frame.title, "hello");
  assert.deepEqual(events, ["message", "session.new"]);
});

test("ephemeral coordinator assigns queue work only after launch", async () => {
  const events: string[] = [];
  const coordinator = new EphemeralCoordinator({
    signedIn: () => true, githubToken: async () => "gh", draftRepo: () => undefined,
    launchMachine: async () => { events.push("launch"); return { id: "m1", nodeId: "n1", provider: "fly" } as any; },
    assignWorkItem: async () => { events.push("assign"); }, nodeLabel: (id: string) => `bivy/${id}`,
    refreshNodes: () => events.push("refresh"),
  } as any);
  await coordinator.runWorkItem("work-1", { provider: "fly" });
  assert.deepEqual(events, ["launch", "refresh", "assign", "refresh"]);
});

test("account coordinator refreshes both automation projections after cancellation", async () => {
  const events: string[] = [];
  const api: any = {
    cancelAutomationRun: async () => { events.push("cancel"); },
    fetchAutomationRuns: async () => { events.push("runs"); return ["run"]; },
    fetchGithubQueue: async () => { events.push("queue"); return ["item"]; },
  };
  const coordinator = new AutomationsAccountCoordinator({ local: {}, api } as any);
  assert.deepEqual(await coordinator.cancelAutomationRun("r1"), { runs: ["run"], queue: ["item"] });
  assert.equal(events[0], "cancel");
  assert.deepEqual(new Set(events.slice(1)), new Set(["runs", "queue"]));
});

test("AppController keeps public compatibility while workflow decisions live outside it", async () => {
  const source = await readFile(new URL("../packages/web/src/store/controller.ts", import.meta.url), "utf8");
  assert.match(source, /switchNode\(nodeId: string\): void \{\s*this\.nodeCoordinator\.switchNode\(nodeId\);/);
  assert.match(source, /return this\.sessionCoordinator\.fork\(sourceSessionId, opts\)/);
  assert.match(source, /return this\.credentialsModelsCoordinator\.testCredential\(provider, label\)/);
  assert.match(source, /this\.sessionCoordinator\.sendPrompt\(text, attachments\)/);
  assert.match(source, /this\.sessionCoordinator\.deleteSession\(sessionId, path\)/);
  assert.doesNotMatch(source, /kind: "session\.fork\.export"/);
  assert.doesNotMatch(source, /kind: "models\.custom\.verify"/);
  assert.ok(source.split("\\n").length < 3700, "controller must not absorb extracted workflows again");
});

test("coordinators remain explicit-port modules", async () => {
  for (const file of ["session-orchestrator", "node-connection-coordinator", "credentials-models-coordinator", "ephemeral-coordinator", "automations-account-coordinator"]) {
    const source = await readFile(new URL(`../packages/web/src/store/coordinators/${file}.ts`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /from ["'][^"']*controller/);
    assert.doesNotMatch(source, /SessionStore|agent-profiles|provider-interpreters|services\/control-plane/);
  }
});
