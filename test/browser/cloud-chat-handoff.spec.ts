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
for (const theme of ["light", "dark"]) for (const outcome of ["reply", "error", "waiting", "empty", "saved", "native"]) {
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
      globalThis.commands = []; globalThis.closedCount = 0; globalThis.persisted = [];
      controller.direct = false; controller.local.s = 'test'; controller.local.cp = ${JSON.stringify(origin)}; controller.local.cur = 'old';
      controller.transport = { close: () => {}, send: async () => {} };
      globalThis.refreshAccountIndex = controller.refreshAccountSessions.bind(controller);
      for (const name of ['refreshAccountSessions','syncAccountCredentialsWithNode','resyncScheduledFollowups','seedEphemeralNodeIfNeeded','maybePromptFirstRunModelAuth','refreshEphemeralCorrelations','refreshSessions','seedAndRequestHistory','observeActivationMilestones']) controller[name] = () => {};
      controller.pendingLaunchStore = { put: async task => globalThis.persisted.push(task.id), remove: async () => {}, list: async () => [] };
      controller.store.setNodes([{ id: 'cloud-node', name: 'Bivy Cloud', online: true }]);
      controller.ephemeralCorrelations = [{ sessionId: 'real-session', nodeId: 'cloud-node', computeSource: 'managed' }];
      controller.store.persistPendingSession('starting-one', 'Test', false, 'Bivy Cloud');
      controller.store.beginOpen('starting-one');
      for (const id of ['account','capacity','machine','service','credentials','repository','agent']) controller.store.updateLaunchCheckpoint('starting-one', id, 'done');
      const task = { id: 'starting-one', config: { name: 'Bivy Cloud', computeSource: 'managed' }, machine: { nodeId: 'cloud-node' }, phase: 'booting', logs: [], followups: [], prompt: { text: 'Test', clientMessageId: 'first', requestId: 'create', frame: { kind: 'session.new', requestId: 'create' } } };
      if (${JSON.stringify(outcome)} === 'saved') {
        task.prompt.frame.model = { id: 'gpt-test', provider: 'openai-codex' };
      }
      if (${JSON.stringify(outcome)} === 'reply') task.prompt.frame.model = { id: 'stale-model', provider: 'previous-node' };
      globalThis.catalogReady = ${JSON.stringify(outcome)} !== 'empty';
      globalThis.catalogQueryError = ${JSON.stringify(outcome)} === 'empty';
      controller.pendingLaunches.set(task.id, task);
      RelayTransport.prototype.connect = async function () { globalThis.connection = this; this.handlers.onStatus('online'); };
      RelayTransport.prototype.close = function () { globalThis.closedCount++; };
      RelayTransport.prototype.send = async function (command) {
        globalThis.commands.push(command.kind);
        if (command.kind === 'session.new') {
          globalThis.creationFrame = command;
          this.handlers.onEvent({ type: 'session.history', sessionId: 'real-session', requestId: 'create', messages: [] });
        }
        if (command.kind === 'models.list' && globalThis.catalogQueryError) throw new Error('offline');
        if (command.kind === 'models.list') this.handlers.onEvent({ type: 'models.list', sessionId: command.sessionId, modelSelection: ${JSON.stringify(outcome)} !== 'native', current: globalThis.selectedModel || (${JSON.stringify(theme)} === 'dark' ? { provider: 'openai-codex', id: 'gpt-test' } : { provider: 'unknown', id: 'unknown' }), models: globalThis.catalogReady && ${JSON.stringify(outcome)} !== 'native' ? [{ id: 'gpt-test', provider: 'openai-codex', label: 'Test model', configured: true }, { id: 'unconnected', provider: 'other', configured: false }] : [] });
        if (command.kind === 'model.select') {
          globalThis.selectedModel = { id: command.id, provider: command.provider };
          if (${JSON.stringify(outcome)} === 'saved') this.handlers.onEvent({ type: 'model.updated', sessionId: 'real-session', model: globalThis.selectedModel });
        }
        if (command.kind === 'prompt') {
          globalThis.delivered = command;
          globalThis.persisted = [];
          this.handlers.onEvent({ type: 'session.user_message', sessionId: 'real-session', clientMessageId: 'first', text: 'Test' });
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
      globalThis.sessionIds = () => controller.store.getState().sessionIndex.sessions.map(session => session.sessionId);
      globalThis.inspect = () => ({ adopted: controller.transport === globalThis.connection, id: controller.store.getState().activeSession.activeSessionId, shouldRestore: controller.shouldAutoResume(), pending: controller.pendingLaunches.size });
    </script></body></html>`);
    await page.route(`${origin}${fixturePath}`, route => route.fulfill({ contentType: "text/html", body: html }));
    await page.goto(`${origin}${fixturePath}`);
    await expect.poll(() => polls).toBeGreaterThan(0);
    expect(await page.evaluate("globalThis.commands")).not.toContain("session.new");
    bootstrapReady = true;
    if (outcome !== "saved" && outcome !== "native") {
    await expect(page.getByText("Choose a model before your first message", { exact: true })).toBeVisible();
    expect(await page.evaluate("globalThis.commands")).not.toContain("prompt");
    await page.evaluate("globalThis.refreshAccountIndex()");
    expect(await page.evaluate("globalThis.sessionIds()")).toEqual(["starting-one"]);
    await page.getByRole("button", { name: "Choose model and send" }).click();
    await expect(page.getByText("unconnected", { exact: true })).toHaveCount(0);
    if (outcome === "empty") {
      await expect(page.getByText(/Couldn't load models from this machine/).last()).toBeVisible();
      await page.evaluate("globalThis.catalogQueryError = false");
      await page.getByRole("button", { name: "Refresh models" }).click();
      await expect(page.getByText(/No connected models are available/)).toBeVisible();
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
    expect(await page.evaluate("globalThis.persisted")).toEqual([]);
    expect(await page.evaluate("globalThis.commands.filter(kind => kind === 'prompt').length")).toBe(1);
    expect(await page.evaluate("globalThis.creationFrame")).not.toHaveProperty("model");
    expect(await page.evaluate("globalThis.delivered")).toMatchObject({ kind: "prompt", sessionId: "real-session", text: "Test", clientMessageId: "first" });
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
