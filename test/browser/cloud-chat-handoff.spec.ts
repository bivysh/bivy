// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "./fixtures.js";
import { createServer, type ViteDevServer } from "../../packages/web/node_modules/vite/dist/node/index.js";
import path from "node:path";
let server: ViteDevServer;
let origin: string;
test.beforeAll(async () => {
  server = await createServer({ root: path.resolve("packages/web"), logLevel: "error", server: { host: "127.0.0.1", port: 0 } });
  await server.listen(); origin = new URL(server.resolvedUrls!.local[0]).origin;
});
test.afterAll(async () => { await server?.close(); });
for (const theme of ["light", "dark"]) for (const outcome of ["reply", "error", "waiting", "empty", "saved", "default", "hydrated", "native", "cancel"]) {
  test(`Cloud chat owns immediate post-ack ${outcome} (${theme})`, async ({ page }, info) => {
    page.on("pageerror", error => console.error(error.message));
    let bootstrapReady = false;
    let polls = 0;
    await page.route(`${origin}/sessions`, route => route.fulfill({ json: [{ sessionId: "real-session", nodeId: "cloud-node" }] }));
    await page.route(`${origin}/nodes`, route => route.fulfill({ json: [{ id: "cloud-node", name: "Bivy Cloud", online: true, bootstrapStatus: { phase: "ready" } }] }));
    await page.route(`${origin}/account/hosted-machines`, route => {
      polls++;
      return route.fulfill({ json: [{ id: "machine", nodeId: "cloud-node", provider: "fly", milestones: bootstrapReady ? { credentialsReadyAt: new Date().toISOString() } : {} }] });
    });
    const fixturePath = `/cloud-handoff-${theme}-${outcome}`;
    const html = await server.transformIndexHtml(fixturePath, `<html data-theme="${theme}"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div class="app"><aside class="sidebar"></aside><main class="main" id="root"></main></div><script type="module">
      import React from 'react'; import { createRoot } from 'react-dom/client';
      import { RelayTransport } from '@bivy/core';
      import { controller, useAppState } from '/src/store/useStore.ts';
      import { ChatView } from '/src/components/ChatView.tsx';
      import { SessionLaunchProgressView } from '/src/components/SessionLaunchProgress.tsx';
      import '/@fs/${path.resolve("packages/ui/tokens.css")}'; import '/src/styles.css';
      globalThis.commands = []; globalThis.closedCount = 0; globalThis.persisted = []; globalThis.delivered = [];
      controller.direct = false; controller.local.s = 'test'; controller.local.cp = ${JSON.stringify(origin)}; controller.local.cur = 'old';
      globalThis.mainCommands = [];
      const mainHandlers = controller.buildTransportHandlers();
      controller.transport = { close: () => { mainHandlers.onStatus('offline'); mainHandlers.onError('Stale connection failed'); }, send: async command => {
        globalThis.mainCommands.push(command);
        if (command.sessionId?.startsWith('starting-')) mainHandlers.onEvent({ type: 'session.error', sessionId: command.sessionId, error: 'Session not found' });
      } };
      globalThis.refreshAccountIndex = controller.refreshAccountSessions.bind(controller);
      for (const name of ['refreshAccountSessions','syncAccountCredentialsWithNode','resyncScheduledFollowups','seedEphemeralNodeIfNeeded','maybePromptFirstRunModelAuth','refreshEphemeralCorrelations','refreshSessions','seedAndRequestHistory','observeActivationMilestones']) controller[name] = () => {};
      controller.pendingLaunchStore = { put: async task => globalThis.persisted.push(task.id), remove: async () => {}, list: async () => [] };
      controller.store.setNodes([{ id: 'cloud-node', name: 'Bivy Cloud', online: true }]);
      controller.ephemeralCorrelations = [{ sessionId: 'real-session', nodeId: 'cloud-node', computeSource: 'managed' }];
      controller.store.persistPendingSession('starting-one', 'Test', false, 'Bivy Cloud');
      controller.store.beginOpen('starting-one');
      for (const id of ['account','capacity','machine','service','credentials','repository','agent']) controller.store.updateLaunchCheckpoint('starting-one', id, 'done');
      const task = { id: 'starting-one', config: { name: 'Bivy Cloud', computeSource: 'managed' }, machine: { nodeId: 'cloud-node' }, phase: 'booting', logs: [], followups: [], prompt: { text: 'Test', clientMessageId: 'first', requestId: 'create', frame: { kind: 'session.new', requestId: 'create' } } };
      if (['saved', 'hydrated'].includes(${JSON.stringify(outcome)})) {
        task.prompt.frame.model = { id: 'gpt-test', provider: 'openai-codex' };
      }
      if (!['saved', 'default', 'hydrated', 'native'].includes(${JSON.stringify(outcome)})) task.prompt.frame.model = { id: 'stale-model', provider: 'previous-node' };
      globalThis.catalogReady = !['empty', 'hydrated'].includes(${JSON.stringify(outcome)});
      globalThis.catalogQueryError = ${JSON.stringify(outcome)} === 'empty';
      controller.pendingLaunches.set(task.id, task);
      globalThis.earlyTeardowns = 0;
      controller.ephemeralCoordinator.teardownFinishedSession = async () => { globalThis.earlyTeardowns++; };
      controller.maybeTeardownFinishedEphemeral(task.id);
      // Same-node credential setup/reconnect must not read or control a local
      // placeholder. Nor may the regular connection consume a launch broadcast.
      controller.openSession(task.id);
      controller.local.cur = 'cloud-node';
      mainHandlers.onStatus('online');
      controller.requestHistory(task.id);
      controller.requestHistory('starting-not-restored');
      controller.requestHistory('established-session');
      controller.chooseModel({ id: 'wrong-source', provider: 'previous-node' });
      controller.setThinkingLevel('high');
      mainHandlers.onEvent({ type: 'session.error', sessionId: task.id, error: 'Session not found' });
      mainHandlers.onEvent({ type: 'session.created', sessionId: 'real-session', name: 'Test' });
      mainHandlers.onEvent({ type: 'session.history', requestId: 'create', sessionId: 'real-session', messages: [] });
      globalThis.staleMainPacket = () => {
        mainHandlers.onEvent({ type: 'session.error', sessionId: 'real-session', error: 'Session not found' });
        mainHandlers.onStatus('offline');
        mainHandlers.onError('Stale connection failed');
        return controller.store.getState().connection.status;
      };
      globalThis.provisionalSafe = controller.store.getState().activeSession.activeSessionId === task.id && !controller.store.getState().sessionIndex.sessions.find(row => row.sessionId === task.id)?.launchProgress?.failedAt;
      RelayTransport.prototype.connect = async function () { globalThis.connection = this; this.handlers.onStatus('online'); };
      RelayTransport.prototype.close = function () {
        globalThis.closedCount++;
        this.handlers.onError?.('Late launch connection error');
        this.handlers.onStatus('online');
      };
      RelayTransport.prototype.send = async function (command) {
        globalThis.commands.push(command.kind);
        if (command.kind === 'session.new') {
          globalThis.creationFrame = command;
          this.handlers.onEvent({ type: 'session.history', sessionId: 'real-session', requestId: 'create', messages: [] });
        }
        if (command.kind === 'models.list' && globalThis.catalogQueryError) throw new Error('offline');
        if (command.kind === 'models.list') this.handlers.onEvent({ type: 'models.list', sessionId: command.sessionId, modelSelection: ${JSON.stringify(outcome)} !== 'native', current: globalThis.selectedModel || (${JSON.stringify(theme)} === 'dark' || ${JSON.stringify(outcome)} === 'default' ? { provider: 'openai-codex', id: 'gpt-test' } : { provider: 'unknown', id: 'unknown' }), models: globalThis.catalogReady && ${JSON.stringify(outcome)} !== 'native' ? [{ id: 'gpt-test', provider: 'openai-codex', label: 'Test model', configured: true }, { id: 'unconnected', provider: 'other', configured: false }] : [] });
        if (command.kind === 'model.select') {
          globalThis.selectedModel = { id: command.id, provider: command.provider };
          if (['saved', 'hydrated'].includes(${JSON.stringify(outcome)})) this.handlers.onEvent({ type: 'model.updated', sessionId: 'real-session', model: globalThis.selectedModel });
        }
        if (command.kind === 'prompt') {
          globalThis.delivered.push(command);
          globalThis.persisted = [];
          this.handlers.onEvent({ type: 'session.user_message', sessionId: 'real-session', clientMessageId: command.clientMessageId, text: command.text });
          // Deliberately emit before send() resolves: there must be no async gap
          // or disposable listener left to swallow the first reply/error.
          if (${JSON.stringify(outcome)} === 'error') this.handlers.onEvent({ type: 'session.error', sessionId: 'real-session', error: 'Model unavailable for this account' });
          else if (${JSON.stringify(outcome)} !== 'waiting') this.handlers.onEvent({ type: 'session.history', sessionId: 'real-session', count: 2, messages: [{ role: 'user', content: 'Test' }, { role: 'assistant', content: [{ type: 'text', text: 'Ready to help.' }] }] });
        }
      };
      function View() {
        const state = useAppState(); const active = state.activeSession;
        const row = state.sessionIndex.sessions.find(s => s.sessionId === active.activeSessionId);
        return React.createElement(ChatView, { entries: active.transcript, working: active.working, workingLabel: active.workingLabel, draftRoute: false, sessionKey: active.activeSessionId,
          header: row?.launchProgress && React.createElement(SessionLaunchProgressView, { progress: row.launchProgress, onChooseModel: model => controller.chooseLaunchModel(row.sessionId, model), onRefreshModels: () => controller.refreshLaunchModels(row.sessionId) }) });
      }
      createRoot(document.getElementById('root')).render(React.createElement(View));
      controller.startPendingRunner(task.id);
      globalThis.staleLaunchPacket = () => {
        const current = task.transport;
        const sessionId = task.sessionId;
        const models = task.models;
        task.transport = { send: async () => {} };
        current.handlers.onEvent({ type: 'session.history', requestId: 'create', sessionId: 'stale-session', messages: [] });
        current.handlers.onStatus('online');
        current.handlers.onError?.('Retired launch callback');
        task.transport = current;
        return task.sessionId === sessionId && task.models === models;
      };
      globalThis.cancelLaunch = () => controller.deleteSession(task.id);
      globalThis.queueDuringRestore = () => {
        let release;
        controller.pendingLaunchRestoration = new Promise(resolve => { release = resolve; });
        controller.pendingLaunches.delete(task.id);
        controller.sendPrompt('Followup');
        controller.pendingLaunches.set(task.id, task);
        release();
      };
      globalThis.queuedFollowups = () => task.followups;
      globalThis.sessionIds = () => controller.store.getState().sessionIndex.sessions.map(session => session.sessionId);
      globalThis.inspect = () => ({ adopted: controller.transport === globalThis.connection, id: controller.store.getState().activeSession.activeSessionId, shouldRestore: controller.shouldAutoResume(), pending: controller.pendingLaunches.size });
    </script></body></html>`);
    await page.route(`${origin}${fixturePath}`, route => route.fulfill({ contentType: "text/html", body: html }));
    await page.goto(`${origin}${fixturePath}`);
    await expect.poll(() => polls).toBeGreaterThan(0);
    expect(await page.evaluate("globalThis.provisionalSafe")).toBe(true);
    expect(await page.evaluate("globalThis.earlyTeardowns")).toBe(0);
    expect(await page.evaluate("globalThis.mainCommands.filter(command => command.sessionId?.startsWith('starting-') || command.kind === 'prompt')")).toEqual([]);
    await expect(page.getByText('Session not found', { exact: true })).toHaveCount(0);
    expect(await page.evaluate("globalThis.mainCommands.some(command => command.kind === 'history' && command.sessionId === 'established-session')")).toBe(true);
    expect(await page.evaluate("globalThis.commands")).not.toContain("session.new");
    bootstrapReady = true;
    if (outcome === "hydrated") {
      await expect(page.getByText("Choose a model before your first message", { exact: true })).toBeVisible();
      expect(await page.evaluate("globalThis.commands")).not.toContain("prompt");
      await page.evaluate("globalThis.catalogReady = true; globalThis.connection.handlers.onEvent({ type: 'providers.list', providers: [] })");
    }
    if (outcome !== "saved" && outcome !== "default" && outcome !== "hydrated" && outcome !== "native") {
    await expect(page.getByText("Choose a model before your first message", { exact: true })).toBeVisible();
    expect(await page.evaluate("globalThis.commands")).not.toContain("prompt");
    await page.evaluate("globalThis.refreshAccountIndex()");
    expect(await page.evaluate("globalThis.sessionIds()")).toEqual(["starting-one"]);
    expect(await page.evaluate("globalThis.staleLaunchPacket()")).toBe(true);
    if (outcome === "cancel") {
      await page.evaluate("globalThis.persisted = []; globalThis.cancelLaunch()");
      expect(await page.evaluate("globalThis.inspect().pending")).toBe(0);
      await page.waitForTimeout(1100);
      expect(await page.evaluate("globalThis.commands")).not.toContain("prompt");
      expect(await page.evaluate("globalThis.commands.filter(kind => kind === 'session.new').length")).toBe(1);
      expect(await page.evaluate("globalThis.persisted")).toEqual([]);
      await expect(page.getByText("Late launch connection error", { exact: true })).toHaveCount(0);
      return;
    }
    if (outcome === "waiting") {
      await page.evaluate("globalThis.queueDuringRestore()");
      await expect.poll(() => page.evaluate("globalThis.queuedFollowups().length")).toBe(1);
      expect(await page.evaluate("globalThis.mainCommands.filter(command => command.kind === 'prompt')")).toEqual([]);
    }
    await page.getByRole("button", { name: "Choose model and send" }).click();
    await expect(page.getByText("unconnected", { exact: true })).toHaveCount(0);
    if (outcome === "empty") {
      await expect(page.getByText(/Couldn't load models from this machine/).last()).toBeVisible();
      await page.evaluate("globalThis.catalogQueryError = false");
      await page.getByRole("button", { name: "Refresh models" }).click();
      // The saved model's provider is absent from the destination catalog, so
      // the error must name the credential-delivery gap, not shrug generically.
      await expect(page.getByText(/Your saved model isn't available on this machine — its previous-node credential didn't reach Bivy Cloud/).last()).toBeVisible();
      expect(await page.evaluate("globalThis.commands")).not.toContain("prompt");
      await page.evaluate("globalThis.catalogReady = true");
      await page.getByRole("button", { name: "Refresh models" }).click();
    }
    await page.getByRole("textbox", { name: "Search models" }).fill("no matching model");
    await expect(page.getByText("No models match your search.")).toBeVisible();
    await page.getByRole("textbox", { name: "Search models" }).fill("");
    await page.screenshot({ path: info.outputPath(`model-choice-${theme}.png`), fullPage: true, animations: "disabled" });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Choose model and send" })).toBeFocused();
    await page.getByRole("button", { name: "Choose model and send" }).click();
    if (outcome === "waiting") await page.clock.install();
    await page.getByText("Test model", { exact: true }).click();
    await expect.poll(() => page.evaluate("globalThis.commands.includes('model.select')")).toBe(true);
    expect(await page.evaluate("globalThis.commands")).not.toContain("prompt");
    await page.evaluate(() => {
      (globalThis as any).connection.handlers.onEvent({ type: "model.updated", sessionId: "unrelated", model: (globalThis as any).selectedModel });
    });
    expect(await page.evaluate("globalThis.commands")).not.toContain("prompt");
    if (outcome === "waiting") {
      await page.clock.runFor(15_010);
      await expect(page.getByText(/Model selection wasn't confirmed/)).toBeVisible();
      expect(await page.evaluate("globalThis.commands")).not.toContain("prompt");
      await page.getByRole("button", { name: "Choose model and send" }).click();
      await page.getByText("Test model", { exact: true }).click();
      await expect.poll(() => page.evaluate("globalThis.commands.filter(kind => kind === 'model.select').length")).toBe(2);
    }
    if (outcome === "error") {
      await page.evaluate(() => (globalThis as any).connection.handlers.onEvent({ type: "session.error", sessionId: "real-session", error: "Model selection rejected" }));
      await expect(page.getByText("Model selection rejected", { exact: true })).toBeVisible();
      expect(await page.evaluate("globalThis.commands")).not.toContain("prompt");
      await page.getByRole("button", { name: "Choose model and send" }).click();
      await page.getByText("Test model", { exact: true }).click();
      await expect.poll(() => page.evaluate("globalThis.commands.filter(kind => kind === 'model.select').length")).toBe(2);
    }
    await page.evaluate(() => (globalThis as any).connection.handlers.onEvent({ type: "model.updated", sessionId: "real-session", model: (globalThis as any).selectedModel }));
    }
    if (!["error", "waiting"].includes(outcome)) {
      await expect(page.getByText("Ready to help.", { exact: true })).toBeVisible();
      await expect(page.getByText(/Agent responded in/)).toBeVisible();
    } else if (outcome === "waiting") {
      await expect(page.getByText(/Waiting for agent response/)).toBeVisible();
      await expect(page.getByText("Test", { exact: true })).toBeVisible();
      await expect(page.getByText(/Agent responded in/)).toHaveCount(0);
    } else {
      await expect(page.getByText("Model unavailable for this account", { exact: true }).first()).toBeVisible();
      await expect(page.getByText(/Startup failed after/)).toBeVisible();
      await expect(page.getByRole("button", { name: /Retry.*Machine/ })).toHaveCount(0);
    }
    expect(await page.evaluate("globalThis.inspect()")).toEqual({ adopted: true, id: "real-session", shouldRestore: false, pending: 0 });
    expect(await page.evaluate("globalThis.staleMainPacket()")).toBe("online");
    await expect(page.getByText('Session not found', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Stale connection failed', { exact: true })).toHaveCount(0);
    expect(await page.evaluate("globalThis.persisted")).toEqual([]);
    expect(await page.evaluate("globalThis.commands.filter(kind => kind === 'prompt').length")).toBe(outcome === "waiting" ? 2 : 1);
    expect(await page.evaluate("globalThis.creationFrame")).not.toHaveProperty("model");
    expect(await page.evaluate("globalThis.delivered[0]")).toMatchObject({ kind: "prompt", sessionId: "real-session", text: "Test", clientMessageId: "first" });
    if (outcome === "waiting") {
      const queued = await page.evaluate("globalThis.queuedFollowups()[0]");
      expect(await page.evaluate("globalThis.delivered[1]")).toMatchObject({ sessionId: "real-session", text: "Followup", clientMessageId: queued.clientMessageId });
    }
    expect(await page.evaluate("globalThis.commands")).toEqual(expect.arrayContaining(["models.list", "runtimes.list", "providers.list"]));
    await page.waitForTimeout(1100);
    expect(await page.evaluate("globalThis.closedCount")).toBe(0);
    await page.screenshot({ path: info.outputPath(`handoff-${theme}-${outcome}.png`), fullPage: true });
    if (outcome === "error") {
      await page.evaluate(() => {
        (globalThis as any).connection.handlers.onEvent({ type: "session.history", sessionId: "real-session", count: 2, messages: [{ role: "user", content: "Test" }, { role: "assistant", content: [{ type: "text", text: "Recovered response." }] }] });
      });
      await expect(page.getByText(/Agent responded in/)).toBeVisible();
      await expect(page.locator(".session-launch-checkpoint.state-failed")).toHaveCount(0);
    }
  });
}
