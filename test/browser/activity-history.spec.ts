// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "../../packages/web/node_modules/vite/dist/node/index.js";

let server: ViteDevServer;
let origin: string;

test.beforeAll(async () => {
  server = await createServer({
    root: fileURLToPath(new URL("../../packages/web", import.meta.url)),
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  const address = server.httpServer!.address();
  if (!address || typeof address === "string") throw new Error("Missing Vite address");
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => { await server?.close(); });

for (const theme of ["light", "dark"]) {
  for (const dismissal of ["backdrop", "close", "escape", "browser back", "rapid close", "nested"]) {
    test(`${theme}: activity ${dismissal} stays in the current session`, async ({ page }, testInfo) => {
      const html = await server.transformIndexHtml('/modal-test', `<!doctype html><html data-theme="${theme}"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div>
          <script type="module">
            import { createElement as h, StrictMode } from 'react';
            import { createRoot } from 'react-dom/client';
            import { flushSync } from 'react-dom';
            import '/src/router.ts';
            import '/@fs/${fileURLToPath(new URL('../../packages/ui/tokens.css', import.meta.url))}';
            import '/src/styles.css';
            const root = createRoot(document.getElementById('root'));
            history.replaceState(null, '', '/sessions/previous');
            history.pushState(null, '', '/sessions/current');
            window.routeEvents = 0;
            window.showNested = () => {
              const host = document.body.appendChild(document.createElement('div'));
              const nested = createRoot(host);
              nested.render(h(Sheet, { title: 'Nested sheet', onClose: () => { nested.unmount(); host.remove(); } }, 'Nested content'));
            };
            // Routing is registered before modal effects. Reopening the session
            // resets its transcript and can synchronously unmount the activity.
            window.addEventListener('popstate', () => {
              window.routeEvents++;
              flushSync(() => root.render(h('p', null, location.pathname)));
            });
            const { ToolGroup } = await import('/src/components/ToolGroup.tsx');
            const { Sheet } = await import('/src/components/Sheet.tsx');
            root.render(h(StrictMode, null, h(ToolGroup, { tools: [
              { callId: 'read-1', name: 'read', input: { path: 'README.md' }, status: 'done', result: 'File contents' }
            ] })));
          </script></body></html>`);
      await page.route(`${origin}/modal-test`, (route) => route.fulfill({ contentType: 'text/html', body: html }));
      await page.goto(`${origin}/modal-test`);
      const opener = page.getByRole("button", { name: /Open work details/ });
      await opener.click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.locator(".activity-row").click();
      await expect(page.locator(".activity-detail")).toBeVisible();
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await expect(page.locator(".activity-row")).toBeVisible();
      if (dismissal === "backdrop") await page.screenshot({ path: testInfo.outputPath(`activity-${theme}.png`) });
      if (dismissal === "nested") {
        const historyLength = await page.evaluate(() => {
          // Open through a real user gesture: Chromium may skip history entries
          // created without activation when exercising browser Back on mobile.
          const button = document.createElement("button");
          button.textContent = "Open nested sheet";
          button.onclick = () => (window as unknown as { showNested(): void }).showNested();
          document.querySelector(".sheet-content")!.append(button);
          return history.length;
        });
        await page.getByRole("button", { name: "Open nested sheet" }).click();
        await expect(page.getByRole("dialog")).toHaveCount(2);
        await expect.poll(() => page.evaluate(() => history.length)).toBe(historyLength + 1);
        await page.goBack();
        await expect(page.getByRole("dialog")).toHaveCount(1);
        await expect(page.locator(".activity-row")).toBeVisible();
        expect(await page.evaluate(() => (window as unknown as { routeEvents: number }).routeEvents)).toBe(0);
        await page.keyboard.press("Escape");
      } else if (dismissal === "rapid close") {
        await page.getByRole("button", { name: "Close", exact: true }).evaluate((button: HTMLButtonElement) => {
          button.click();
          button.click();
          button.click();
        });
      } else if (dismissal === "backdrop") await page.locator(".sheet-backdrop").click({ position: { x: 5, y: 5 } });
      else if (dismissal === "close") await page.getByRole("button", { name: "Close", exact: true }).click();
      else if (dismissal === "escape") await page.keyboard.press("Escape");
      else await page.goBack();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(page).toHaveURL(`${origin}/sessions/current`);
      expect(await page.evaluate(() => (window as unknown as { routeEvents: number }).routeEvents)).toBe(0);
      await expect(opener).toBeFocused();
      // Once the overlay is gone, ordinary Back still navigates sessions.
      await page.goBack();
      await expect(page).toHaveURL(`${origin}/sessions/previous`);
      await expect(page.getByText('/sessions/previous', { exact: true })).toBeVisible();
    });
  }
}
