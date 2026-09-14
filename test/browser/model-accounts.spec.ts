// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "@playwright/test";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type ViteDevServer } from "../../packages/web/node_modules/vite/dist/node/index.js";
import { modelAccountChoice } from "../../packages/web/src/modelAccounts.js";

let server: ViteDevServer;
let origin: string;
let cacheDir: string;
test.beforeAll(async () => {
  const root = path.resolve("packages/web");
  cacheDir = await mkdtemp(path.join(root, "node_modules/.vite-model-accounts-"));
  server = await createServer({ root, cacheDir, logLevel: "silent", server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  const address = server.httpServer!.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await server?.close(); if (cacheDir) await rm(cacheDir, { recursive: true, force: true }); });

test("account routing follows project, active, default and ambiguity rules", () => {
  const records = [{ label: "default" }, { label: "work" }];
  const config = { active: "personal", presets: { personal: { anthropic: "default" }, default: { anthropic: "work" }, "project:acme/app": { anthropic: "work" } } };
  expect(modelAccountChoice("anthropic", records, config, "acme/app")).toEqual({ preset: "project:acme/app", label: "work" });
  expect(modelAccountChoice("anthropic", records, config)).toEqual({ preset: "personal", label: "default" });
  expect(modelAccountChoice("anthropic", records, config, "/repos/acme__app/.bivy/worktrees/session")).toEqual({ preset: "project:/repos/acme__app/.bivy/worktrees/session", label: "work" });
  expect(modelAccountChoice("anthropic", records, { presets: { default: { anthropic: "work" } } }).label).toBe("work");
  expect(modelAccountChoice("anthropic", records, {}).label).toBe("default");
  expect(modelAccountChoice("anthropic", [{ label: "work" }], {}).label).toBe("work");
  expect(modelAccountChoice("anthropic", [{ label: "home" }, { label: "work" }], {}).label).toBeUndefined();
  expect(modelAccountChoice("anthropic", records, { active: "bad", presets: { bad: { anthropic: "missing" } } }).label).toBeUndefined();
  expect(modelAccountChoice("anthropic", records, null).label).toBeUndefined();
});

for (const theme of ["light", "dark"]) for (const width of [390, 1280]) {
  test(`model picker accounts ${theme} ${width}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    const html = await server.transformIndexHtml("/model-account-test", `<html data-theme="${theme}"><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module">
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { ModelPicker } from '/src/components/Pickers.tsx';
      import { controller } from '/src/store/controller.ts';
      import '/@fs/${path.resolve("packages/ui/tokens.css")}';
      import '/src/styles.css';
      import '/src/ux-cleanup.css';
      for (const method of ['listModels', 'listProviders', 'listCredentialRecords', 'getCredentialPresets']) controller[method] = () => {};
      let state = structuredClone(controller.store.getState());
      state.connection.status = 'online';
      state.draft.repo = 'acme/app';
      state.catalogs.models = [{ id: 'claude-sonnet', label: 'Claude Sonnet', provider: 'anthropic' }, { id: 'gpt-5', label: 'GPT-5', provider: 'openai-codex' }];
      state.catalogs.providers = [{ id: 'anthropic', name: 'Anthropic' }, { id: 'openai-codex', name: 'OpenAI — ChatGPT subscription' }];
      state.settings.credentialRecords = ['anthropic', 'openai-codex'].flatMap(provider => ['default', 'work'].map(label => ({ provider, label, kind: 'oauth' })));
      state.settings.credentialPresets = {};
      const root = createRoot(document.getElementById('root'));
      function render() { root.render(React.createElement(ModelPicker, { state, onClose() {} })); }
      window.failSave = false;
      window.setAccountState = (patch) => {
        state = { ...state, settings: { ...state.settings, ...patch } };
        render();
      };
      controller.setPresetMapping = async (preset, provider, label) => {
        window.selection = { preset, provider, label };
        await new Promise(resolve => setTimeout(resolve, 200));
        if (window.failSave) throw new Error('Could not switch account');
        state = { ...state, settings: { ...state.settings, credentialPresets: { presets: { [preset]: { [provider]: label } } } } };
        render();
      };
      render();
    </script></body></html>`);
    await page.route(`${origin}/model-account-test`, route => route.fulfill({ contentType: "text/html", body: html }));
    await page.goto(`${origin}/model-account-test`);
    const chevron = page.getByRole("button", { name: "Change account for Claude Sonnet" });
    await expect(page.getByText("anthropic · default", { exact: true })).toBeVisible();
    await expect(page.getByText("openai-codex · default", { exact: true })).toBeVisible();
    await expect(page.getByRole("combobox")).toHaveCount(0);
    await page.getByPlaceholder("Search models…").fill("claude");
    await chevron.focus();
    await page.keyboard.press("Enter");
    const nested = page.getByRole("dialog", { name: "Claude Sonnet account" });
    await expect(nested).toBeVisible();
    await expect(nested.locator(".picker-item-row.active")).toContainText("default");
    await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
    await page.screenshot({ path: testInfo.outputPath("model-account-choices.png"), fullPage: true });
    await page.getByRole("button", { name: /^work.*Subscription sign-in$/ }).click();
    await expect(page.getByText("anthropic · work", { exact: true })).toBeVisible();
    await expect(chevron).toBeFocused();
    await expect(page.getByPlaceholder("Search models…")).toHaveValue("claude");
    await page.getByPlaceholder("Search models…").fill("");
    expect(await page.evaluate(() => (window as any).selection)).toEqual({ preset: "project:acme/app", provider: "anthropic", label: "work" });
    await page.mouse.move(0, 0);
    await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
    await page.screenshot({ path: testInfo.outputPath("model-accounts.png"), fullPage: true });
    await page.evaluate(() => { (window as any).failSave = true; });
    await chevron.click();
    await page.getByRole("button", { name: /^default.*Subscription sign-in$/ }).click();
    await expect(page.getByRole("alert")).toHaveText("Could not switch account");
    await expect(nested.locator(".picker-item-row.active")).toContainText("work");
    await page.getByRole("button", { name: "Back to models" }).click();
    await expect(chevron).toBeFocused();
    await chevron.click();
    await page.keyboard.press("Escape");
    await expect(chevron).toBeVisible();
    await chevron.click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.evaluate(() => (window as any).setAccountState({ credentialPresets: null }));
    await expect(page.getByRole("button", { name: /^work.*Subscription sign-in$/ })).toBeDisabled();
    await expect(page.getByRole("status")).toHaveText("Loading accounts…");
    await page.evaluate(() => (window as any).setAccountState({ credentialRecords: [] }));
    await expect(page.getByText("No saved accounts available on this machine.")).toBeVisible();
    await page.getByRole("button", { name: "Back to models" }).click();
    await expect(chevron).toHaveCount(0);
    await expect(page.getByText("Claude Sonnet", { exact: true })).toBeVisible();
  });
}
