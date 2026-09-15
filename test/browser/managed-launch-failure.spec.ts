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

for (const theme of ["light", "dark"]) {
  for (const credentials of [false, true]) {
    test(`failed launch offers the correct recovery without active spinners (${theme}, credentials=${credentials})`, async ({ page }, info) => {
      const progress = { startedAt: 1000, failedAt: 3000, checkpoints: {
        account: { state: "failed", error: "Launch failed", ...(credentials ? { errorCode: "managed_credentials_required" } : {}) },
        capacity: { state: "active" },
      } };
      const fixturePath = `/failure-fixture-${theme}-${credentials}`;
      const html = await server.transformIndexHtml(fixturePath, `<html data-theme="${theme}"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module">
        import React from 'react'; import { createRoot } from 'react-dom/client';
        import { SessionLaunchProgressView } from '/src/components/SessionLaunchProgress.tsx';
        import '/@fs/${path.resolve("packages/ui/tokens.css")}'; import '/src/styles.css';
        globalThis.recovery = [];
        createRoot(document.getElementById('root')).render(React.createElement(SessionLaunchProgressView, {
          progress: ${JSON.stringify(progress)},
          onSetupCredentials: async () => { globalThis.recovery.push('credentials'); },
          onRetryLaunch: async () => { globalThis.recovery.push('same-request'); },
          onRetryFreshMachine: async () => { globalThis.recovery.push('fresh'); }
        }));
      </script></body></html>`);
      await page.route(`${origin}${fixturePath}`, route => route.fulfill({ contentType: "text/html", body: html }));
      await page.goto(`${origin}${fixturePath}`);
      await expect(page.getByText("Startup failed after 2s")).toBeVisible();
      await expect(page.locator(".state-active")).toHaveCount(0);
      const name = credentials ? "Set up model credentials" : "Retry this launch";
      const button = page.getByRole("button", { name, exact: true });
      await button.focus();
      await expect(button).toBeFocused();
      await expect(page.getByRole("button")).toHaveCount(1);
      await page.screenshot({ path: info.outputPath(`failure-${theme}-${credentials}.png`), fullPage: true });
      await button.press("Enter");
      expect(await page.evaluate("globalThis.recovery")).toEqual([credentials ? "credentials" : "same-request"]);
    });
  }
}
