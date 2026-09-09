// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "@playwright/test";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const webRoot = fileURLToPath(new URL("../../packages/web/", import.meta.url));
const require = createRequire(new URL("../../packages/web/package.json", import.meta.url));
let server: { listen(): Promise<unknown>; close(): Promise<void>; resolvedUrls: { local: string[] } | null };
let origin: string;
test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  const { createServer } = await import(pathToFileURL(require.resolve("vite")).href);
  server = await createServer({ root: webRoot, server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
  await server.listen();
  origin = new URL(server.resolvedUrls!.local[0]).origin;
});
test.afterAll(async () => { await server?.close(); });

for (const theme of ["light", "dark"]) {
  test(`badge matches session attention and clears on resume (${theme})`, async ({ page }, testInfo) => {
    // Exercise the real App with store snapshots and mocked OS badge I/O.
    await page.addInitScript((theme) => {
      localStorage.setItem("bivy_theme", theme);
      Object.assign(window, { badgeCount: 16, badgeClears: 0 });
      Object.defineProperties(navigator, {
        setAppBadge: { value: async (count: number) => { Object.assign(window, { badgeCount: count }); } },
        clearAppBadge: { value: async () => {
          const state = window as unknown as { badgeCount: number; badgeClears: number };
          state.badgeCount = 0;
          state.badgeClears++;
        } },
      });
    }, theme);
    await page.route("**/api/**", route => route.fulfill({ json: {} }));
    // Keep network connection/reconnect out of this store-driven App fixture.
    await page.route("**/src/main.tsx", async route => {
      const response = await route.fetch();
      const source = (await response.text()).replace("controller.connect();", "").replace("controller.installLifecycleHandlers();", "");
      await route.fulfill({ response, body: source });
    });
    await page.goto(origin);
    await page.evaluate(async () => {
      const modulePath = "/src/store/useStore.ts";
      const { controller } = await import(modulePath);
      controller.store.setCurrentNode("node-a");
      // These legacy Inbox items are not session-list notifications.
      controller.store.setNodes([{ id: "node-a", name: "Test machine", online: true,
        providers: Array.from({ length: 16 }, (_, i) => ({ id: `provider-${i}`, configured: true, expiresAt: 1 })),
      }]);
      controller.store.set({ sessions: [{ sessionId: "seen", name: "Reviewed session", status: "idle", finishedAt: 20, lastSeenAt: 30 }] });
    });
    const badgeCount = () => page.evaluate(() => (window as unknown as { badgeCount: number }).badgeCount);
    await expect.poll(badgeCount).toBe(0);
    await expect(page).toHaveTitle("Bivy");

    await page.evaluate(async () => {
      const modulePath = "/src/store/useStore.ts";
      const { controller } = await import(modulePath);
      controller.store.set({ sessions: [
        { sessionId: "seen", name: "Reviewed session", status: "idle", finishedAt: 20, lastSeenAt: 30 },
        { sessionId: "new", name: "Unread result", nodeId: "node-a", status: "idle", finishedAt: 40, lastSeenAt: 30 },
        { sessionId: "blocked", name: "Approval waiting", nodeId: "node-b", status: "needs_action", needsAction: true },
        { sessionId: "working", name: "Still working", status: "working" },
      ] });
    });
    await expect.poll(badgeCount).toBe(2);
    await expect(page).toHaveTitle("(2) Bivy");
    if (testInfo.project.name === "mobile") {
      const openSessions = page.getByRole("button", { name: "Open sessions — something needs your attention", exact: true });
      await openSessions.focus();
      await expect(openSessions).toBeFocused();
      await page.keyboard.press("Enter");
    }
    await expect(page.getByText("Needs attention", { exact: true })).toBeVisible();
    await expect(page.getByText("Unread result", { exact: true })).toBeVisible();
    await expect(page.getByText("Approval waiting", { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`attention-${theme}.png`), fullPage: true });
    // A local search must not clear real attention on other sessions/machines.
    await page.getByRole("searchbox", { name: "Search sessions" }).fill("Reviewed session");
    await expect(page.getByText("Approval waiting", { exact: true })).toHaveCount(0);
    expect(await badgeCount()).toBe(2);
    await page.getByRole("searchbox", { name: "Search sessions" }).fill("");

    await page.evaluate(async () => {
      const modulePath = "/src/store/useStore.ts";
      const { controller } = await import(modulePath);
      controller.store.set({ sessions: [{ sessionId: "new", name: "Read result", status: "idle", finishedAt: 40, lastSeenAt: 50 }] });
    });
    await expect.poll(badgeCount).toBe(0);
    await expect(page).toHaveTitle("Bivy");
    await expect(page.getByText("Needs attention", { exact: true })).toHaveCount(0);
    // An iOS resume need not change any React state. Clear a stale OS badge again.
    for (const event of ["focus", "pageshow", "visibilitychange"]) {
      await page.evaluate(event => {
        Object.assign(window, { badgeCount: 16 });
        (event === "visibilitychange" ? document : window).dispatchEvent(new Event(event));
      }, event);
      await expect.poll(badgeCount).toBe(0);
    }
    await page.screenshot({ path: testInfo.outputPath(`cleared-${theme}.png`), fullPage: true });
  });
}
