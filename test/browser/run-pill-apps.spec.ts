// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "./fixtures.js";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type ViteDevServer } from "../../packages/web/node_modules/vite/dist/node/index.js";

// The published-app launcher card anchors chronologically in the transcript, so
// after a long turn it scrolls out of view. The run pill's action sheet — the
// same sheet that surfaces the PR, branch, changes and artifacts — is the stable
// way back: it shows "N apps" and reopens the Apps sheet. This renders the real
// RunPill and proves that affordance appears, is keyboard-reachable, and fires.
let server: ViteDevServer;
let origin: string;
let cacheDir: string;
test.beforeAll(async () => {
  const root = path.resolve("packages/web");
  cacheDir = await mkdtemp(path.join(root, "node_modules/.vite-run-pill-apps-"));
  server = await createServer({ root, cacheDir, logLevel: "silent", server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  const address = server.httpServer!.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await server?.close(); if (cacheDir) await rm(cacheDir, { recursive: true, force: true }); });

for (const theme of ["light", "dark"]) {
  test(`run pill surfaces published apps and opens the apps sheet (${theme})`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const html = await server.transformIndexHtml("/run-pill-apps", `<html data-theme="${theme}"><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module">
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { RunPill } from '/src/components/RunPill.tsx';
      import '/@fs/${path.resolve("packages/ui/tokens.css")}';
      import '/src/styles.css';
      import '/src/ux-cleanup.css';
      window.opened = 0;
      createRoot(document.getElementById('root')).render(React.createElement(RunPill, {
        anchorId: 'attention-s1',
        source: { kind: 'cli', label: 'Terminal session', automation: false },
        statusClass: 'idle',
        statusLabel: 'Idle',
        gh: { issueUrl: null, prUrl: null, branch: null, repo: null, prs: [] },
        filesEdited: 3,
        onOpenChanges: () => {},
        artifactsCount: 1,
        onOpenArtifacts: () => {},
        appsCount: 2,
        onOpenApps: () => { window.opened += 1; },
      }));
    </script></body></html>`);
    await page.route(`${origin}/run-pill-apps`, (route) => route.fulfill({ contentType: "text/html", body: html }));
    await page.goto(`${origin}/run-pill-apps`);

    // The pill itself carries the status; apps live one tap deeper in its sheet.
    await page.locator("#attention-s1").click();
    const appsRow = page.getByRole("button", { name: /2 apps/ });
    await expect(appsRow).toBeVisible();
    await expect(appsRow).toContainText("Open apps");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`run-pill-apps-${theme}.png`), fullPage: true });

    // Keyboard-reachable and wired to the parent's open handler.
    await appsRow.focus();
    await expect(appsRow).toBeFocused();
    await appsRow.click();
    // dismiss() runs the sheet's close motion before invoking the handler.
    await expect.poll(() => page.evaluate(() => (window as unknown as { opened: number }).opened)).toBe(1);
    expect(errors).toEqual([]);
  });
}

test("run pill omits the apps affordance when nothing is published", async ({ page }) => {
  const html = await server.transformIndexHtml("/run-pill-noapps", `<html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module">
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { RunPill } from '/src/components/RunPill.tsx';
    import '/@fs/${path.resolve("packages/ui/tokens.css")}';
    import '/src/styles.css';
    import '/src/ux-cleanup.css';
    createRoot(document.getElementById('root')).render(React.createElement(RunPill, {
      anchorId: 'attention-s2',
      source: { kind: 'cli', label: 'Terminal session', automation: false },
      statusClass: 'idle', statusLabel: 'Idle',
      gh: { issueUrl: null, prUrl: null, branch: null, repo: null, prs: [] },
      appsCount: 0, onOpenApps: () => {},
    }));
  </script></body></html>`);
  await page.route(`${origin}/run-pill-noapps`, (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto(`${origin}/run-pill-noapps`);
  await page.locator("#attention-s2").click();
  await expect(page.getByText("Open apps")).toHaveCount(0);
});
