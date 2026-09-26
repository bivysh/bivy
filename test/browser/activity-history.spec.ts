// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, themes, type WebApp } from "./fixtures.js";
import { fileURLToPath } from "node:url";

let server: WebApp;
let origin: string;

test.beforeAll(async ({ webApp }) => {
  server = webApp;
  origin = webApp.origin;
});


for (const theme of themes) {
  test(`${theme}: failed commands do not require attention`, async ({ page }, testInfo) => {
    const html = await server.transformIndexHtml('/activity-test', `<!doctype html><html data-theme="${theme}"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div>
      <script type="module">
        import { createElement as h } from 'react';
        import { createRoot } from 'react-dom/client';
        import '/@fs/${fileURLToPath(new URL('../../packages/ui/tokens.css', import.meta.url))}';
        import '/src/styles.css';
        import { ToolGroup } from '/src/components/ToolGroup.tsx';
        const failed = { callId: 'failed', name: 'bash', input: { command: 'false' }, status: 'done', detail: { kind: 'shell', command: 'false', result: { exitCode: 1 } } };
        const running = { callId: 'running', name: 'bash', input: { command: 'pnpm test' }, status: 'running' };
        const done = { callId: 'done', name: 'read', input: { path: 'README.md' }, status: 'done' };
        createRoot(document.getElementById('root')).render(h('main', { className: 'chat-messages' },
          ...[[failed], [failed, running], [done], [running]].map((tools, key) => h(ToolGroup, { key, tools }))));
      </script></body></html>`);
    await page.route(`${origin}/activity-test`, (route) => route.fulfill({ contentType: 'text/html', body: html }));
    await page.goto(`${origin}/activity-test`);
    await expect(page.locator('.tool-group-label')).toHaveText(['Worked', 'Working', 'Worked', 'Working']);
    await expect(page.getByText('Needs attention')).toHaveCount(0);
    const failed = page.getByRole('button', { name: /^Worked:.*1 failed.*Open work details$/ });
    await expect(failed).toBeVisible();
    await expect(page.getByRole('button', { name: /^Working:.*1 failed.*Open work details$/ })).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(failed).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath(`activity-outcomes-${theme}.png`) });
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.locator('.activity-row')).toContainText('Failed');
    await page.locator('.activity-row').click();
    await expect(page.locator('.activity-detail')).toContainText('Failed · exit 1');
    await page.keyboard.press('Escape');
    await expect(failed).toBeFocused();
  });

  // Only the dismissals that touch browser history differ from modal-history's
  // generic Sheet coverage: they must not leak into session routing.
  for (const dismissal of ["browser back", "rapid close", "nested"]) {
    test(`${theme}: activity ${dismissal} stays in the current session`, async ({ page }) => {
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
      } else await page.goBack();
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
