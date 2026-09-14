// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "./fixtures.js";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type ViteDevServer } from "../../packages/web/node_modules/vite/dist/node/index.js";

let server: ViteDevServer;
let origin: string;
let cacheDir: string;
test.beforeAll(async () => {
  const root = path.resolve("packages/web");
  cacheDir = await mkdtemp(path.join(root, "node_modules/.vite-run-details-"));
  server = await createServer({ root, cacheDir, logLevel: "silent", server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  const address = server.httpServer!.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await server?.close(); if (cacheDir) await rm(cacheDir, { recursive: true, force: true }); });

for (const theme of ["light", "dark"]) {
  test(`run details refresh queued → running → finished (${theme})`, async ({ page }, testInfo) => {
    let status = "pending";
    let offline = false;
    let requests = 0;
    await page.route(`${origin}/fixture-record`, route => {
      requests++;
      return route.fulfill({ contentType: "application/json", status: offline ? 503 : 200, body: JSON.stringify({
        id: "run-1", title: "GitHub Issue #187", source: "github:issue", status,
        targetKind: "new_session", attempt: 1, createdAt: "2026-09-10T19:51:00Z",
        ...(status !== "pending" ? { output: { sessionId: "session-1" } } : {}),
      }) });
    });
    const html = await server.transformIndexHtml("/run-fixture", `<html data-theme="${theme}"><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module">
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { RunDetails } from '/src/components/RunDetails.tsx';
      import '/@fs/${path.resolve("packages/ui/tokens.css")}';
      import '/src/styles.css';
      import '/src/ux-cleanup.css';
      createRoot(document.getElementById('root')).render(React.createElement(RunDetails, {
        runId: 'run-1', load: async () => { const r = await fetch('/fixture-record'); if (!r.ok) throw new Error('Offline'); return r.json(); },
        onClose: () => {}, onCancel: async () => {}, onOpenSession: () => {}, isSessionResolvable: () => true,
      }));
    </script></body></html>`);
    await page.route(`${origin}/run-fixture`, route => route.fulfill({ contentType: "text/html", body: html }));
    await page.clock.install();
    await page.goto(`${origin}/run-fixture`);
    const header = page.locator(".run-sheet-status");
    await expect(header).toHaveText("Queued");
    await expect(header.locator(".badge")).toHaveCount(0);
    await page.getByRole("button", { name: "Cancel Run", exact: true }).focus();
    await expect(page.getByRole("button", { name: "Cancel Run", exact: true })).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`run-queued-${theme}.png`), fullPage: true });

    // Being assigned to a machine still isn't executing the agent.
    status = "claimed";
    await page.clock.runFor(5_000);
    await expect.poll(() => requests).toBe(2);
    await expect(header).toHaveText("Queued");

    offline = true;
    await page.clock.runFor(5_000);
    await expect(page.getByText("Showing the last known state")).toBeVisible();
    await expect(header).toHaveText("Queued");

    offline = false;
    status = "running";
    await page.clock.runFor(5_000);
    await expect(header).toHaveText("Running");
    await expect(page.getByText("Showing the last known state")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Open Session", exact: true })).toBeVisible();
    await expect(header.locator(".badge")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`run-running-${theme}.png`), fullPage: true });

    status = "waiting";
    await page.clock.runFor(5_000);
    await expect(header).toHaveText("Waiting");
    await expect(header.locator(".badge")).toHaveCount(0);

    status = "needs_attention";
    await page.clock.runFor(5_000);
    await expect(header).toHaveText("Needs attention · Needs review");

    status = "cancelled";
    await page.clock.runFor(5_000);
    await expect(header).toHaveText("Finished · Cancelled");
    await expect(page.getByRole("button", { name: "Cancel Run", exact: true })).toHaveCount(0);
    const terminalRequests = requests;
    await page.clock.runFor(15_000);
    expect(requests).toBe(terminalRequests);
  });
}
