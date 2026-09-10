import { expect, test } from "./fixtures.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "../../packages/web/node_modules/vite/dist/node/index.js";

interface UpdateTestWindow extends Window {
  setDraft(value: boolean): void;
  registrationOptions: { onNeedReload(): void };
  registration: { waiting: unknown };
  worker: { transition(state: string): void };
  lastMessage: unknown;
}

let server: ViteDevServer;
let origin: string;
test.beforeAll(async () => {
  server = await createServer({
    root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../packages/web"),
    logLevel: "silent",
    cacheDir: `node_modules/.vite-pwa-update-${process.pid}`,
    optimizeDeps: { include: ["react", "react-dom/client", "react/jsx-dev-runtime"] },
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  const address = server.httpServer!.address();
  if (!address || typeof address === "string") throw new Error("No test server port");
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await server.close(); });

for (const theme of ["light", "dark"]) {
  test(`explicit update reload and retry (${theme})`, async ({ page }, info) => {
    await page.route(`${origin}/update-test`, route => route.fulfill({
      contentType: "text/html",
      body: `<html data-theme="${theme}"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>
        <div id="root"></div><script type="module">
        import RefreshRuntime from '/@react-refresh';
        RefreshRuntime.injectIntoGlobalHook(window);
        window.$RefreshReg$ = () => {};
        window.$RefreshSig$ = () => type => type;
        window.__vite_plugin_react_preamble_installed__ = true;
        </script><script type="module">
        import React from '/node_modules/.vite-pwa-update-${process.pid}/deps/react.js';
        import ReactDOM from '/node_modules/.vite-pwa-update-${process.pid}/deps/react-dom_client.js';
        import '/@fs/${path.resolve("packages/ui/tokens.css")}';
        import '/src/styles.css';
        import '/src/ux-cleanup.css';
        import '/src/pwa-lifecycle.css';
        import { UpdatePrompt } from '/src/components/UpdatePrompt.tsx';
        import { initPwa } from '/src/pwa.ts';
        import { setComposerLifecycle } from '/src/pwaLifecycle.ts';
        sessionStorage.loads = String(Number(sessionStorage.loads || 0) + 1);
        class Worker extends EventTarget {
          state = 'installed';
          postMessage(message) { window.lastMessage = message; }
          transition(state) { this.state = state; this.dispatchEvent(new Event('statechange')); }
        }
        window.worker = new Worker();
        window.registration = { waiting: window.worker };
        Object.defineProperty(navigator.serviceWorker, 'getRegistration', { value: async () => window.registration });
        window.setDraft = hasDraft => setComposerLifecycle({ hasDraft, pendingAttachments: 0, readingAttachments: false });
        initPwa();
        ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(UpdatePrompt));
        </script></body></html>`,
    }));
    await page.route("**/@vite-plugin-pwa/virtual:pwa-register", route => route.fulfill({
      contentType: "application/javascript",
      body: `export function registerSW(options) {
        window.registrationOptions = options;
        options.onNeedRefresh();
        return async () => {};
      }`,
    }));
    await page.goto(`${origin}/update-test`);
    const reload = page.getByRole("button", { name: "Reload", exact: true });
    await expect(reload).toBeVisible();
    await page.evaluate(() => (window as unknown as UpdateTestWindow).setDraft(true));
    await expect(reload).toBeDisabled();
    // An update activated by another tab must never discard this tab's draft.
    await page.evaluate(() => (window as unknown as UpdateTestWindow).registrationOptions.onNeedReload());
    expect(await page.evaluate(() => sessionStorage.loads).catch(() => null)).toBe("1");
    await page.evaluate(() => (window as unknown as UpdateTestWindow).setDraft(false));
    await reload.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Updating…" })).toBeDisabled();
    expect(await page.evaluate(() => (window as unknown as UpdateTestWindow).lastMessage)).toEqual({ type: "SKIP_WAITING" });
    await page.evaluate(() => (window as unknown as UpdateTestWindow).worker.transition("redundant"));
    await expect(page.getByRole("alert")).toContainText("try Reload again");
    await expect(reload).toBeEnabled();
    await page.screenshot({ path: info.outputPath(`update-error-${theme}.png`) });
    // Retry with a stale prompt: the waiting worker disappeared meanwhile.
    await page.evaluate(() => { (window as unknown as UpdateTestWindow).registration.waiting = null; });
    await reload.click();
    await expect.poll(() => page.evaluate(() => sessionStorage.loads).catch(() => null)).toBe("2");
    // Wait for activation, but don't reload if new work appeared during it.
    await page.getByRole("button", { name: "Reload", exact: true }).click();
    await expect(page.getByRole("button", { name: "Updating…" })).toBeVisible();
    await page.evaluate(() => {
      (window as unknown as UpdateTestWindow).setDraft(true);
      (window as unknown as UpdateTestWindow).worker.transition("activated");
      (window as unknown as UpdateTestWindow).registration.waiting = null;
    });
    await expect(reload).toBeDisabled();
    expect(await page.evaluate(() => sessionStorage.loads).catch(() => null)).toBe("2");
    await page.evaluate(() => (window as unknown as UpdateTestWindow).setDraft(false));
    await reload.click();
    await expect.poll(() => page.evaluate(() => sessionStorage.loads).catch(() => null)).toBe("3");
    // The normal path explicitly reloads once activation finishes.
    await reload.click();
    await expect(page.getByRole("button", { name: "Updating…" })).toBeVisible();
    await page.evaluate(() => (window as unknown as UpdateTestWindow).worker.transition("activated"));
    await expect.poll(() => page.evaluate(() => sessionStorage.loads).catch(() => null)).toBe("4");
  });
}
