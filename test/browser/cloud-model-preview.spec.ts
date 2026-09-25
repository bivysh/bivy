// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, themes } from "./fixtures.js";
import { createServer, type ViteDevServer } from "../../packages/web/node_modules/vite/dist/node/index.js";
import path from "node:path";

let server: ViteDevServer;
let origin: string;
test.beforeAll(async () => {
  server = await createServer({ root: path.resolve("packages/web"), logLevel: "error", server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  origin = new URL(server.resolvedUrls!.local[0]).origin;
});
test.afterAll(async () => { await server?.close(); });

for (const theme of themes) test(`Cloud model selection before any machine exists (${theme})`, async ({ page }, info) => {
  const url = `/cloud-model-preview-${theme}`;
  const html = await server.transformIndexHtml(url, `<html data-theme="${theme}"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div class="app"><aside class="sidebar"></aside><main class="main" id="root"></main></div><script type="module">
    import React from 'react'; import { createRoot } from 'react-dom/client';
    import { controller, useAppState } from '/src/store/useStore.ts';
    import { Composer } from '/src/components/Composer.tsx';
    import '/@fs/${path.resolve("packages/ui/tokens.css")}'; import '/src/styles.css';
    controller.direct = false; controller.local.cur = ''; controller.local.s = 'test';
    globalThis.commands = [];
    controller.transport = { send: async command => globalThis.commands.push(command), close: () => {} };
    let loadModels;
    const catalogReady = new Promise(resolve => { loadModels = resolve; });
    globalThis.loadModels = () => loadModels();
    controller.ephemeralKeys = {
      modelKeyEntries: async () => { await catalogReady; return [{ provider: 'anthropic', scope: 'account', key: 'never-render-this-key' }, { provider: 'openai', scope: 'device', key: 'private-device-key' }]; },
      oauthCredentialEntries: async () => [{ provider: 'openai-codex', refresh: 'never-render-this-token' }],
    };
    controller.store.apply({ type: 'runtimes.list', current: { id: 'pi', name: 'Pi' }, runtimes: [{ id: 'pi', name: 'Pi', capabilities: { modelSelection: true } }] });
    globalThis.disableRuntimeModels = () => controller.store.apply({ type: 'runtime.updated', current: { id: 'pi', name: 'Pi' }, runtimes: [{ id: 'pi', name: 'Pi', capabilities: { modelSelection: false } }] });
    globalThis.beginLaunch = () => {
      controller.store.apply({ type: 'runtime.updated', current: { id: 'pi', name: 'Pi' }, runtimes: [{ id: 'pi', name: 'Pi', capabilities: { modelSelection: true } }] });
      controller.store.persistPendingSession('starting-test', 'Test', false, 'Bivy Cloud');
      controller.store.beginOpen('starting-test');
    };
    const handlers = controller.buildTransportHandlers();
    controller.pickDraftEphemeralRunner({ id: 'cloud', name: 'Bivy Cloud', computeSource: 'managed' });
    globalThis.staleModels = () => handlers.onEvent({ type: 'models.list', models: [{ id: 'wrong-machine', provider: 'other' }] });
    globalThis.draftFields = () => controller.draftSessionFields();
    globalThis.models = () => controller.store.getState().catalogs.models;
    function View() {
      const state = useAppState();
      return React.createElement(React.Fragment, null, React.createElement('div', { className: 'chat' }),
        React.createElement(Composer, { state, disabled: false, working: false, onAbort: () => {},
          onSend: text => { globalThis.sent = { text, ...controller.draftSessionFields() }; } }));
    }
    createRoot(document.getElementById('root')).render(React.createElement(View));
  </script></body></html>`);
  await page.route(`${origin}${url}`, route => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto(`${origin}${url}`);
  await page.getByRole("textbox").fill("Test, are we up?");
  const pill = page.locator(".model-pill");
  await expect(pill).toBeEnabled();
  await expect(pill).toContainText("Choose a model");
  await pill.click();
  const picker = page.getByRole("dialog", { name: "Model", exact: true });
  await expect(picker).toBeVisible();
  await page.evaluate("globalThis.loadModels()");
  await expect(picker.getByText("Claude Opus 4.8", { exact: true })).toBeVisible();
  await expect(picker.getByText("GPT-5.6 Sol", { exact: true })).toBeVisible();
  expect(await page.evaluate("globalThis.models().some(model => model.provider === 'openai')")).toBe(false);
  await page.evaluate("globalThis.staleModels()");
  await expect(picker.getByText("Claude Opus 4.8", { exact: true })).toBeVisible();
  expect(await page.evaluate("globalThis.commands.some(command => ['models.list', 'session.new', 'model.select'].includes(command.kind))")).toBe(false);
  expect(await page.locator('body').textContent()).not.toContain('never-render');
  await page.screenshot({ path: info.outputPath(`cloud-model-preview-${theme}.png`), fullPage: true, animations: "disabled" });
  await page.getByPlaceholder("Search models…").fill("no-match");
  await expect(page.getByText("No models available.")).toBeVisible();
  await page.getByPlaceholder("Search models…").fill("Claude Opus 4.8");
  const choice = picker.getByRole("button", { name: /Claude Opus 4.8/ });
  await choice.focus();
  await expect(choice).toBeFocused();
  await page.keyboard.press("Enter");
  expect(await page.evaluate("globalThis.draftFields().model")).toEqual({ id: "claude-opus-4-8", provider: "anthropic" });
  expect(await page.evaluate("globalThis.commands.some(command => command.kind === 'model.select')")).toBe(false);
  await expect(picker).not.toBeVisible();
  await expect(pill).toContainText("Claude Opus 4.8");
  await expect(page.getByRole("textbox")).toHaveValue("Test, are we up?");
  await page.screenshot({ path: info.outputPath(`cloud-composer-${theme}.png`), fullPage: true, animations: "disabled" });
  await page.getByRole("button", { name: "Launch Machine and send task", exact: true }).click();
  expect(await page.evaluate("globalThis.sent")).toMatchObject({ text: "Test, are we up?", model: { id: "claude-opus-4-8", provider: "anthropic" } });
  await page.evaluate("globalThis.disableRuntimeModels()");
  await expect(pill).toBeDisabled();
  await expect(pill).toHaveAttribute("title", "This agent uses its own default model");
  await page.evaluate("globalThis.beginLaunch()");
  await expect(pill).toBeDisabled();
  await expect(pill).toHaveAttribute("data-pending-model", "true");
});
