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
for (const theme of ["light", "dark"]) {
  test(`delete a retired session without opening or contacting its machine (${theme})`, async ({ page }, info) => {
    let fail = true;
    let requests = 0;
    await page.route("**/session-correlation/retired", async route => {
      expect(route.request().method()).toBe("DELETE"); requests++;
      await route.fulfill(fail ? { status: 503, json: { error: "test outage" } } : { status: 204 });
    });
    const fixturePath = `/retired-fixture-${theme}`;
    const html = await server.transformIndexHtml(fixturePath, `<html data-theme="${theme}"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div class="app"><div class="sidebar open" id="root"></div><main class="main"></main></div><script type="module">
      import React from 'react'; import { createRoot } from 'react-dom/client';
      import { SessionList } from '/src/components/SessionList.tsx';
      import { controller } from '/src/store/useStore.ts';
      import '/@fs/${path.resolve("packages/ui/tokens.css")}'; import '/src/styles.css';
      controller.direct = false; controller.local.s = 'test'; controller.local.cp = ${JSON.stringify(origin)};
      controller.ephemeralCorrelations = [{ sessionId: 'retired', nodeId: 'eph-retired', provider: 'fly' }];
      controller.refreshSessions = () => {};
      controller.send = () => { throw new Error('must not send to a retired or unrelated node'); };
      controller.store.setSessions([
        { sessionId: 'retired', nodeId: 'eph-retired', name: 'Tear', status: 'saved', rebuildable: true }
      ]);
      controller.store.persistPendingSession('starting-failed', 'Long failed startup name that must not clip its Dismiss action', false, 'Bivy Cloud');
      controller.store.failPendingSession('starting-failed');
      globalThis.picked = false;
      createRoot(document.getElementById('root')).render(React.createElement(SessionList, { onPick: () => { globalThis.picked=true; }, onPickTerminal: () => {} }));
    </script></body></html>`);
    await page.route(`${origin}${fixturePath}`, route => route.fulfill({ contentType: "text/html", body: html }));
    await page.goto(`${origin}${fixturePath}`);
    const remove = page.getByRole("button", { name: "Delete Tear", exact: true });
    await remove.focus(); await expect(remove).toBeFocused();
    await remove.press("Enter");
    await expect(page.getByRole("dialog", { name: "Delete saved session?" })).toBeVisible();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(requests).toBe(0);
    await remove.click(); await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect.poll(() => requests).toBe(1);
    await expect(remove).toBeEnabled();
    await page.screenshot({ path: info.outputPath(`retired-${theme}.png`), fullPage: true });
    const dismiss = await page.getByRole("button", { name: "Dismiss", exact: true }).boundingBox();
    expect(dismiss!.x + dismiss!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    fail = false;
    await remove.click(); await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(remove).toHaveCount(0);
    expect(requests).toBe(2);
    expect(await page.evaluate("globalThis.picked")).toBe(false);
  });
}
