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
  cacheDir = await mkdtemp(path.join(root, "node_modules/.vite-session-source-"));
  server = await createServer({ root, cacheDir, logLevel: "silent", server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  const address = server.httpServer!.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await server?.close(); if (cacheDir) await rm(cacheDir, { recursive: true, force: true }); });

for (const theme of ["light", "dark"]) {
  test(`repository sessions show creating triggers (${theme})`, async ({ page }, testInfo) => {
    const html = await server.transformIndexHtml("/source-fixture", `<html data-theme="${theme}"><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root" style="width: var(--sidebar-width); max-width: 100%"></div><script type="module">
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { SessionList } from '/src/components/SessionList.tsx';
      import { indexSessionSources } from '/src/sessionSource.ts';
      import { controller } from '/src/store/controller.ts';
      import '/@fs/${path.resolve("packages/ui/tokens.css")}';
      import '/src/styles.css';
      import '/src/ux-cleanup.css';
      controller.refreshSessions = () => {};
      const names = ['CI failed: CI #1947', 'CI failed: CI #1946', 'Continuous Agent Improvement', 'Manually opened session'];
      controller.store.setSessions(names.map((name, i) => ({ id: 's' + i, name, source: 'repo:bivysh/bivy', modified: new Date(Date.now() - i * 60000).toISOString(), status: 'saved', agent: 'pi', agentName: 'Pi' })));
      const sources = indexSessionSources(names.slice(0, 3).map((title, i) => ({ id: 'r' + i, source: 'schedule', title, targetKind: 'new_session', createdAt: new Date().toISOString(), output: { sessionId: 's' + i } })));
      createRoot(document.getElementById('root')).render(React.createElement(SessionList, { sessionSources: sources, onPick: () => {}, onPickTerminal: () => {} }));
    </script></body></html>`);
    await page.route(`${origin}/source-fixture`, route => route.fulfill({ contentType: "text/html", body: html }));
    await page.goto(`${origin}/source-fixture`);
    for (const name of ["CI failed: CI #1947", "CI failed: CI #1946", "Continuous Agent Improvement"]) {
      const row = page.getByRole("button", { name: new RegExp(name) });
      await expect(row).toContainText("Scheduled run");
      await expect(row).toContainText("bivysh/bivy");
    }
    const manual = page.getByRole("button", { name: /Manually opened session/ });
    await expect(manual).toContainText("App session");
    await manual.focus();
    await expect(manual).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`session-sources-${theme}.png`), fullPage: true });
  });
}
