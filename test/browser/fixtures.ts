import { test as base, expect } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "../../packages/web/node_modules/vite/dist/node/index.js";

export * from "@playwright/test";

export const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../packages/web");

// One Vite dev server per worker, not per spec file.
//
// Every spec used to call createServer() itself, so a run booted ~26 dev servers
// and transformed the whole app from cold in each of them; nine also handed Vite
// an empty mkdtemp cacheDir, forcing a full dependency pre-bundle every time.
// That, not the assertions, was most of the browser lane's wall clock.
//
// Worker scope is what makes the server shareable: Playwright keeps one instance
// alive for every spec a worker runs, so the transform cost is paid once per
// worker instead of once per file, and specs stay isolated because each test
// still gets a fresh browser context.
//
// The dependency cache is shared and pre-warmed by globalSetup (see
// test/browser/global-setup.ts) so no worker pays a cold pre-bundle and no two
// workers race to write one.
export const viteCacheDir = path.join(webRoot, "node_modules/.vite-browser-tests");

export type WebApp = {
  /** `http://127.0.0.1:<port>` for this worker's dev server. */
  origin: string;
  /** Vite's index-HTML transform, for specs that mount their own entry module. */
  transformIndexHtml(url: string, html: string): Promise<string>;
};

export async function startWebServer(): Promise<{ server: ViteDevServer; origin: string }> {
  const server = await createServer({
    root: webRoot,
    cacheDir: viteCacheDir,
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("Vite dev server reported no port");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

// Themes that behavior specs repeat over. Their assertions do not depend on the
// theme, so CI runs light only; screenshots.spec.ts owns the light + dark visual
// contract. Set PW_THEMES=light,dark locally to get dark review screenshots too.
export const themes = (process.env.PW_THEMES ?? "light").split(",") as ("light" | "dark")[];

// These are UI tests, not live-backend tests. Page-level routes in individual
// specs take precedence over this context-level safety net, including deliberate
// error responses. Never let an omitted mock reach the developer's local daemon.
export const test = base.extend<{ apiIsolation: void }, { webApp: WebApp }>({
  // Playwright reads the destructuring pattern to work out which fixtures this
  // one depends on, so the empty pattern is required rather than stylistic.
  // eslint-disable-next-line no-empty-pattern
  webApp: [async ({}, use) => {
    const { server, origin } = await startWebServer();
    await use({ origin, transformIndexHtml: (url, html) => server.transformIndexHtml(url, html) });
    await server.close();
  }, { scope: "worker" }],

  apiIsolation: [async ({ context }, use) => {
    const unexpected: string[] = [];
    await context.route(url => url.pathname === "/api" || url.pathname.startsWith("/api/"), async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() === "GET" && url.pathname === "/api/push/preferences") {
        await route.fulfill({ json: { preferences: {
          question_asked: true,
          approval_requested: true,
          agent_waiting: true,
          session_done: true,
          session_error: true,
          terminal_bell: true,
        } } });
        return;
      }
      unexpected.push(`${request.method()} ${request.url()}`);
      await route.fulfill({ status: 501, json: { error: "Missing browser-test API mock" } });
    });
    await use();
    expect(unexpected, "Unexpected API requests: add explicit mocks (including intentional failures)").toEqual([]);
  }, { auto: true }],
});
