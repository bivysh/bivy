// SPDX-License-Identifier: AGPL-3.0-only
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { NodeConnectionCoordinator } from "../packages/web/src/store/coordinators/node-connection-coordinator.js";
import { CredentialsModelsCoordinator } from "../packages/web/src/store/coordinators/credentials-models-coordinator.js";
import { SessionOrchestrator } from "../packages/web/src/store/coordinators/session-orchestrator.js";
import { EphemeralCoordinator } from "../packages/web/src/store/coordinators/ephemeral-coordinator.js";
import { AutomationsAccountCoordinator } from "../packages/web/src/store/coordinators/automations-account-coordinator.js";
import { FollowupCoordinator } from "../packages/web/src/store/coordinators/followup-coordinator.js";

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

test("credentials coordinator uses the item-addressed probe in direct mode", async () => {
  let sent = false;
  const coordinator = new CredentialsModelsCoordinator({
    send: () => { sent = true; },
    awaitAck: async () => ({ type: "credential.test.result", ok: true, at: 41 } as never),
    rememberModel: () => {},
    selectModelLocally: () => {},
    isDirect: () => true,
    now: () => 42,
    isOnline: () => true,
    importModelKeys: async () => {},
    removeModelKey: async () => {},
    accountModelKeys: async () => [],
  });
  assert.deepEqual(await coordinator.testCredential("openai", "default"), { ok: true, at: 41 });
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
    launchManagedDestination: async () => "managed-node",
  });
  const result = coordinator.fork("source", {});
  assert.equal(command.kind, "session.fork.local");
  assert.equal(coordinator.handleEvent({ type: "session.fork.done", requestId: "request-1", sessionId: "forked", fidelity: "full" } as any), true);
  assert.deepEqual(await result, { sessionId: "forked", fidelity: "full", missing: [] });
  assert.equal(opened, "forked");
});

test("session coordinator provisions a managed fork only after export and before import", async () => {
  const events: string[] = [];
  const commands: any[] = [];
  let request = 0;
  const coordinator = new SessionOrchestrator({
    send: (command) => events.push(`send:${command.kind}`),
    sendRequest: (command) => { commands.push(command); events.push(`request:${command.kind}`); },
    createRequestId: () => `request-${++request}`,
    createClientMessageId: () => "message-1",
    currentNodeId: () => "source-node",
    isDirect: () => false,
    sessionRuntime: () => "claude",
    switchNode: (nodeId) => events.push(`switch:${nodeId}`),
    waitForOnline: async () => { events.push("online"); },
    openSession: (id) => events.push(`open:${id}`),
    addUserMessage: () => {},
    transcriptUrl: () => "https://app/sessions/source",
    refreshAccountSessions: () => {},
    launchManagedDestination: async (configId) => { events.push(`launch:${configId}`); return "managed-node"; },
  });
  const result = coordinator.fork("source", { managedConfigId: "managed-default", agentId: "codex", sourceAgentId: "claude" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(commands[0]?.kind, "session.fork.export");
  coordinator.handleEvent({ type: "session.fork.exported", requestId: "request-1", bundle: { version: 1 } } as any);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events.slice(0, 5), [
    "request:session.fork.export",
    "launch:managed-default",
    "switch:managed-node",
    "online",
    "request:session.fork.import",
  ]);
  coordinator.handleEvent({ type: "session.fork.done", requestId: "request-2", sessionId: "forked", runtimeId: "codex", fidelity: "seeded" } as any);
  assert.deepEqual(await result, { sessionId: "forked", fidelity: "seeded", missing: [] });
  assert.ok(events.includes("open:forked"));
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
    launchManagedDestination: async () => "managed-node",
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

test("ephemeral coordinator restores managed sessions without a device cloud token or room key", async () => {
  const events: string[] = [];
  const coordinator = new EphemeralCoordinator({
    currentNodeId: () => "eph-managed",
    roomKey: () => undefined,
    correlations: () => [{ sessionId: "s1", nodeId: "eph-managed", provider: "fly", setupId: "managed-default", computeSource: "managed" }],
    restoreManagedMachine: async (input: unknown) => { events.push(`restore:${JSON.stringify(input)}`); return { nodeId: "eph-managed" } as any; },
    connectToNode: async (nodeId: string) => { events.push(`connect:${nodeId}`); },
    direct: () => false,
    reportError: (error: Error) => { throw error; },
  } as any);
  assert.equal(coordinator.isCurrentNodeResumable(), true, "hosted escrow makes a managed correlation rebuildable on a fresh device");
  await coordinator.reprovision("eph-managed", "s1");
  assert.deepEqual(events, [
    'restore:{"configId":"managed-default","nodeId":"eph-managed","sessionId":"s1"}',
    "connect:eph-managed",
  ]);
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

test("follow-up coordinator owns queue timing and delivery", () => {
  const sent: any[] = [];
  const followups: any[] = [{ id: "f1", text: "next", status: "queued", version: 1, createdAt: 1, updatedAt: 1 }];
  let working = false;
  const store: any = {
    getState: () => ({ activeSession: { activeSessionId: "s1", working }, catalogs: { selectedAgentId: "pi", runtimes: [] } }),
    getFollowups: () => followups,
    reorderFollowup: () => true,
    markFollowupSending: (_sid: string, id: string) => { followups.find((item) => item.id === id).status = "sending"; },
    addUserMessage: () => {}, confirmFollowupSent: () => {}, editFollowup: () => ({ ok: false }), removeFollowup: () => false,
  };
  const coordinator = new FollowupCoordinator(store, {
    send: (command) => sent.push(command), createClientMessageId: () => "new", now: () => 10,
    persistBackstop: () => {}, cancelBackstop: () => {},
  });
  assert.equal(coordinator.mustQueue("s1"), true, "an earlier queued item preserves ordering even while idle");
  coordinator.drain("s1");
  assert.equal(sent[0].kind, "prompt");
  assert.equal(followups[0].status, "sending");
  working = true;
  assert.equal(coordinator.steer("urgent"), false, "steer is unavailable until the runtime advertises it");
});

test("AppController keeps public compatibility while workflow decisions live outside it", async () => {
  const source = await readFile(new URL("../packages/web/src/store/controller.ts", import.meta.url), "utf8");
  assert.match(source, /switchNode\(nodeId: string\): void \{\s*this\.nodeCoordinator\.switchNode\(nodeId\);/);
  assert.match(source, /return this\.sessionCoordinator\.fork\(sourceSessionId, opts\)/);
  assert.match(source, /return this\.credentialsModelsCoordinator\.testCredential\(provider, label\)/);
  assert.match(source, /this\.sessionCoordinator\.sendPrompt\(text, attachments\)/);
  assert.match(source, /this\.sessionCoordinator\.deleteSession\(sessionId, path\)/);
  assert.match(source, /return this\.followupCoordinator\.edit\(sessionId, id, patch, expectedVersion\)/);
  assert.doesNotMatch(source, /kind: "session\.fork\.export"/);
  assert.doesNotMatch(source, /kind: "models\.custom\.verify"/);
  assert.ok(source.split("\\n").length < 3700, "controller must not absorb extracted workflows again");
});

test("coordinators remain explicit-port modules", async () => {
  for (const file of ["session-orchestrator", "node-connection-coordinator", "credentials-models-coordinator", "ephemeral-coordinator", "automations-account-coordinator", "followup-coordinator"]) {
    const source = await readFile(new URL(`../packages/web/src/store/coordinators/${file}.ts`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /from ["'][^"']*controller/);
    assert.doesNotMatch(source, /SessionStore|agent-profiles|provider-interpreters|services\/control-plane/);
  }
});
