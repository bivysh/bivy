// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "./fixtures.js";
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

for (const theme of ["light", "dark"]) test(`Cloud model selection before any machine exists (${theme})`, async ({ page }, info) => {
  const url = `/cloud-model-preview-${theme}`;
  const html = await server.transformIndexHtml(url, `<html data-theme="${theme}"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module">
    import React from 'react'; import { createRoot } from 'react-dom/client';
    import { controller, useAppState } from '/src/store/useStore.ts';
    import { ModelPicker } from '/src/components/Pickers.tsx';
    import '/@fs/${path.resolve("packages/ui/tokens.css")}'; import '/src/styles.css';
    controller.direct = false; controller.local.cur = ''; controller.local.s = 'test';
    globalThis.commands = [];
    controller.transport = { send: async command => globalThis.commands.push(command), close: () => {} };
    controller.ephemeralKeys = {
      modelKeyEntries: async () => [{ provider: 'anthropic', scope: 'account', key: 'never-render-this-key' }, { provider: 'openai', scope: 'device', key: 'private-device-key' }],
      oauthCredentialEntries: async () => [{ provider: 'openai-codex', refresh: 'never-render-this-token' }],
    };
    const handlers = controller.buildTransportHandlers();
    controller.pickDraftEphemeralRunner({ id: 'cloud', name: 'Bivy Cloud', computeSource: 'managed' });
    globalThis.staleModels = () => handlers.onEvent({ type: 'models.list', models: [{ id: 'wrong-machine', provider: 'other' }] });
    globalThis.draftFields = () => controller.draftSessionFields();
    globalThis.models = () => controller.store.getState().catalogs.models;
    function View() {
      const state = useAppState(); const [open, setOpen] = React.useState(true);
      return open ? React.createElement(ModelPicker, { state, onClose: () => setOpen(false) }) : React.createElement('p', null, state.catalogs.currentModel?.label);
    }
    createRoot(document.getElementById('root')).render(React.createElement(View));
  </script></body></html>`);
  await page.route(`${origin}${url}`, route => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto(`${origin}${url}`);
  await expect(page.getByText("Claude Opus 4.8", { exact: true })).toBeVisible();
  await expect(page.getByText("GPT-5.6 Sol", { exact: true })).toBeVisible();
  expect(await page.evaluate("globalThis.models().some(model => model.provider === 'openai')")).toBe(false);
  await page.evaluate("globalThis.staleModels()");
  await expect(page.getByText("Claude Opus 4.8", { exact: true })).toBeVisible();
  expect(await page.evaluate("globalThis.commands.some(command => ['models.list', 'session.new', 'model.select'].includes(command.kind))")).toBe(false);
  expect(await page.locator('body').textContent()).not.toContain('never-render');
  await page.screenshot({ path: info.outputPath(`cloud-model-preview-${theme}.png`), fullPage: true, animations: "disabled" });
  await page.getByPlaceholder("Search models…").fill("no-match");
  await expect(page.getByText("No models available.")).toBeVisible();
  await page.getByPlaceholder("Search models…").fill("Claude Opus 4.8");
  const choice = page.getByRole("button", { name: /Claude Opus 4.8/ });
  await choice.focus();
  await expect(choice).toBeFocused();
  await page.keyboard.press("Enter");
  expect(await page.evaluate("globalThis.draftFields().model")).toEqual({ id: "claude-opus-4-8", provider: "anthropic" });
  expect(await page.evaluate("globalThis.commands.some(command => command.kind === 'model.select')")).toBe(false);
});
