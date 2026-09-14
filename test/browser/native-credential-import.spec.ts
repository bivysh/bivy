// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "@playwright/test";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type ViteDevServer } from "../../packages/web/node_modules/vite/dist/node/index.js";

let server: ViteDevServer;
let origin: string;
let cacheDir: string;
test.beforeAll(async () => {
  const root = path.resolve("packages/web");
  cacheDir = await mkdtemp(path.join(root, "node_modules/.vite-native-import-"));
  server = await createServer({ root, cacheDir, logLevel: "silent", server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  const address = server.httpServer!.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await server?.close(); if (cacheDir) await rm(cacheDir, { recursive: true, force: true }); });

for (const theme of ["light", "dark"]) for (const width of [390, 1280]) {
  test(`settings native login import ${theme} ${width}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const html = await server.transformIndexHtml("/native-import-test", `<html data-theme="${theme}"><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root" class="settings-body"></div><script type="module">
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { CredentialVault } from '/src/components/CredentialVault.tsx';
      import { controller } from '/src/store/controller.ts';
      import '/@fs/${path.resolve("packages/ui/tokens.css")}';
      import '/src/styles.css';
      import '/src/ux-cleanup.css';
      for (const method of ['listProviders', 'listCredentialRecords', 'getCredentialPresets', 'listLocalModels', 'listRepos']) controller[method] = () => {};
      controller.direct = false;
      controller.listEphemeralModelKeys = async () => [];
      let state = structuredClone(controller.store.getState());
      state.connection = { ...state.connection, status: 'online', currentNodeId: 'one', nodes: [
        { id: 'one', name: 'My laptop', online: true },
        { id: 'two', name: 'Development workstation with a deliberately long machine name', online: true },
        { id: 'off', name: 'Offline machine', online: false }
      ] };
      const root = createRoot(document.getElementById('root'));
      function render() { root.render(React.createElement(CredentialVault, { state })); }
      window.scanMode = 'ready';
      window.configureConnection = (patch, direct = false) => { controller.direct = direct; state = { ...state, connection: { ...state.connection, ...patch } }; render(); };
      controller.switchNode = id => { state = { ...state, connection: { ...state.connection, currentNodeId: id, status: 'connecting' } }; render(); setTimeout(() => { state = { ...state, connection: { ...state.connection, status: 'online' } }; render(); }, 250); };
      controller.previewNativeCredentials = async (nodeId, label) => {
        window.scanRequest = { nodeId, label };
        await new Promise(resolve => setTimeout(resolve, 250));
        if (window.scanMode === 'error') throw new Error('Could not scan this machine. Try again.');
        return { previewId: 'preview-' + nodeId, label: label || 'default', items: [
          { agent: 'claude', provider: 'anthropic', kind: 'oauth', status: window.scanMode === 'empty' ? 'missing' : 'ready' },
          { agent: 'codex', provider: 'openai-codex', kind: 'oauth', status: 'conflict' },
          { agent: 'grok', status: 'missing' }
        ] };
      };
      controller.importNativeCredentials = async (nodeId, previewId, agents, sync) => {
        window.importRequest = { nodeId, previewId, agents, sync };
        await new Promise(resolve => setTimeout(resolve, 250));
        return { items: agents.map(agent => ({ agent, status: 'imported' })) };
      };
      render();
    </script></body></html>`);
    await page.route(`${origin}/native-import-test`, route => route.fulfill({ contentType: "text/html", body: html }));
    await page.goto(`${origin}/native-import-test`);
    await page.getByRole("button", { name: "Import from machine", exact: true }).click();
    await expect(page.getByLabel("Source machine")).toBeFocused();
    await expect(page.getByRole("option", { name: "Offline machine — offline" })).toBeDisabled();
    await page.getByLabel("Source machine").selectOption("two");
    await expect(page.getByRole("button", { name: "Scan for logins" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Scan for logins" })).toBeEnabled();
    await page.getByRole("button", { name: "Scan for logins" }).click();
    await expect(page.getByText("Reading login files on the selected machine…")).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "Import Claude" })).toBeChecked();
    await expect(page.getByRole("checkbox", { name: "Import Codex" })).toBeDisabled();
    await expect(page.getByLabel("Available on")).toHaveValue("node");
    await page.getByRole("checkbox", { name: "Import Claude" }).uncheck();
    await expect(page.getByRole("button", { name: "Import selected logins" })).toBeDisabled();
    await page.getByRole("checkbox", { name: "Import Claude" }).focus();
    await page.keyboard.press("Space");
    await page.getByLabel("Available on").selectOption("account");
    await page.screenshot({ path: testInfo.outputPath("native-import-preview.png"), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole("button", { name: "Import 1 login", exact: true }).click();
    await expect(page.getByText("Claude: Imported", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as any).importRequest)).toEqual({ nodeId: "two", previewId: "preview-two", agents: ["claude"], sync: "account" });
    await page.screenshot({ path: testInfo.outputPath("native-import-success.png"), fullPage: true });
    await page.getByLabel("Source machine").selectOption("one");
    await expect(page.getByText("Claude: Imported", { exact: true })).toHaveCount(0);
    await page.evaluate(() => { (window as any).scanMode = "error"; });
    await page.getByRole("button", { name: "Scan for logins" }).click();
    await expect(page.getByRole("alert")).toContainText("Could not scan");
    await page.evaluate(() => { (window as any).scanMode = "empty"; });
    await page.getByRole("button", { name: "Scan for logins" }).click();
    await expect(page.getByText(/^No new logins to import/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Import selected logins" })).toBeDisabled();
    await page.getByRole("button", { name: "‹ Credentials" }).click();
    await expect(page.getByRole("heading", { name: "Your model access" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Import from machine", exact: true })).toBeFocused();
    await page.evaluate(() => (window as any).configureConnection({ currentNodeId: null, nodes: [], status: 'offline' }));
    await page.getByRole("button", { name: "Import from machine", exact: true }).click();
    await expect(page.getByRole("button", { name: "Scan for logins" })).toBeDisabled();
    await expect(page.getByText("Connect an online machine to scan its logins.")).toBeVisible();
    await page.evaluate(() => (window as any).configureConnection({ status: 'online', nodes: [{ id: 'remote', name: 'Other machine', online: true }] }, true));
    await expect(page.getByLabel("Source machine")).toBeDisabled();
    await expect(page.getByRole("option", { name: 'Other machine' })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Scan for logins" })).toBeEnabled();
  });
}
