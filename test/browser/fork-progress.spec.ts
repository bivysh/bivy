// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "./fixtures.js";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(new URL("../../packages/web/package.json", import.meta.url));
let server: any;
let url: string;
test.beforeAll(async () => {
  const { createServer } = await import(require.resolve("vite"));
  server = await createServer({ root: path.resolve("packages/web"), server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  url = server.resolvedUrls.local[0];
});
test.afterAll(async () => { await server?.close(); });

test.beforeEach(async ({ page }) => {
  await page.routeWebSocket(/.*/, () => {});
  // Bootstrap runs before we replace the transport below. This fixture supplies
  // controller state itself; explicitly model the absent daemon during startup.
  for (const endpoint of ["auth/bootstrap", "sessions", "auth/credentials/account-export", "models", "runtimes", "stt/config"]) {
    await page.route(new RegExp(`/api/${endpoint}(?:\\?|$)`), route => route.fulfill({
      status: 503, json: { error: "Daemon intentionally offline in fork UI fixture" },
    }));
  }
  await page.goto(url);
  await page.evaluate(async () => {
    // Exercise the real app/controller; hold protocol replies to inspect every
    // transition deterministically without provisioning real agent processes.
    const { controller: c } = await import(/* @vite-ignore */ "/src/store/useStore.ts" as string);
    (window as any).forkController = c;
    c.transport.close();
    c.transport.send = async () => {};
    c.store.setError("");
    c.store.setStatus("online");
    c.store.apply({ type: "runtimes.list", runtimes: [
      { id: "claude", name: "Claude", status: "available" },
      { id: "codex", name: "Codex", status: "available" },
    ] });
    c.store.apply({ type: "sessions.list", sessions: [{ sessionId: "source", name: "Source conversation", runtimeId: "claude", status: "saved" }] });
    c.openSession("source");
    c.store.apply({ type: "session.history", sessionId: "source", runtimeId: "claude", messages: [{ role: "user", content: "Original conversation" }] });
    (window as any).forkRequests = [];
    c.sessionCoordinator.deps.sendRequest = (command: unknown) => (window as any).forkRequests.push(command);
  });
});

for (const theme of ["light", "dark"]) {
  for (const entry of ["menu", "picker"]) {
    test(`${entry} fork stays modal until canonical history is available (${theme})`, async ({ page }, testInfo) => {
      await page.evaluate((value) => document.documentElement.dataset.theme = value, theme);
      if (entry === "menu") {
        await page.getByRole("button", { name: "Session actions" }).click();
        await page.getByRole("menuitem", { name: /Fork/ }).click();
        await page.getByRole("button", { name: "Create fork" }).click();
      } else {
        await page.getByRole("button", { name: "Claude", exact: true }).click();
        await page.getByRole("button", { name: /Codex/ }).click();
      }
      const dialog = page.getByRole("dialog", { name: "Forking session" });
      await expect(dialog).toBeVisible();
      await expect.poll(() => page.evaluate(() => (window as any).forkRequests.length)).toBe(1);
      await expect(page).toHaveURL(/\/sessions\/source$/);
      await page.keyboard.press("Escape");
      await page.keyboard.press("Tab");
      await expect(dialog).toBeVisible();
      expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
      if (entry === "picker") {
        await expect(dialog).toContainText("Preparing the conversation");
        await page.evaluate(() => {
          const c = (window as any).forkController;
          c.sessionCoordinator.handleEvent({ type: "session.fork.bundle", requestId: (window as any).forkRequests[0].requestId, bundle: { record: {} } });
        });
        await expect(dialog).toContainText("Creating the session in the destination agent");
      } else {
        await expect(dialog).toContainText("Copying the conversation");
      }
      await page.screenshot({ path: testInfo.outputPath(`fork-${entry}-${theme}.png`) });
      await page.evaluate((runtimeId) => {
        const c = (window as any).forkController;
        c.sessionCoordinator.handleEvent({ type: "session.fork.done", requestId: (window as any).forkRequests.at(-1).requestId,
          sessionId: "destination", runtimeId, messages: [{ role: "user", content: "Forked conversation ready" }], missing: [], fidelity: "full" });
      }, entry === "picker" ? "codex" : "claude");
      await expect(dialog).toHaveCount(0);
      await expect(page).toHaveURL(/\/sessions\/destination$/);
      await expect(page.getByText("Forked conversation ready", { exact: true })).toBeVisible();
      await expect(page.getByText("Original conversation", { exact: true })).toHaveCount(0);
      // No stale modal sentinel may send the app back to the source after success.
      await page.waitForTimeout(300);
      await expect(page).toHaveURL(/\/sessions\/destination$/);
    });
  }
}

test("progress survives cross-machine resets and source retirement", async ({ page }) => {
  await page.evaluate(() => {
    const c = (window as any).forkController;
    let current = "source-node";
    c.store.setCurrentNode(current);
    c.store.setNodes([{ id: current, name: "Source", online: true }, { id: "destination-node", name: "Destination", online: true }]);
    c.sessionCoordinator.deps.isDirect = () => false;
    c.sessionCoordinator.deps.currentNodeId = () => current;
    c.sessionCoordinator.deps.switchNode = (id: string) => { current = id; c.store.resetSession(); c.store.setCurrentNode(id); };
    c.sessionCoordinator.deps.waitForOnline = () => new Promise<void>((resolve) => { (window as any).finishConnection = resolve; });
  });
  await page.getByRole("button", { name: "Session actions" }).click();
  await page.getByRole("menuitem", { name: /Fork/ }).click();
  await page.getByLabel("Destination machine").selectOption("destination-node");
  await page.getByRole("button", { name: "Move session", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).forkRequests.length)).toBe(1);
  await page.evaluate(() => {
    (window as any).forkController.sessionCoordinator.handleEvent({ type: "session.fork.bundle", requestId: (window as any).forkRequests[0].requestId, bundle: { record: {} } });
  });
  const dialog = page.getByRole("dialog", { name: "Forking session" });
  await expect(dialog).toContainText("Connecting to the destination machine");
  await page.evaluate(() => (window as any).finishConnection());
  await expect.poll(() => page.evaluate(() => (window as any).forkRequests.length)).toBe(2);
  await expect(dialog).toContainText("Creating the session");
  await page.evaluate(() => {
    (window as any).forkController.sessionCoordinator.handleEvent({ type: "session.fork.done", requestId: (window as any).forkRequests[1].requestId,
      sessionId: "destination", runtimeId: "claude", messages: [{ role: "user", content: "Moved conversation" }] });
  });
  await expect(dialog).toContainText("Retiring the original session");
  await expect(page).toHaveURL(/\/sessions\/source$/);
  await page.evaluate(() => (window as any).finishConnection());
  await expect.poll(() => page.evaluate(() => (window as any).forkController.store.getState().connection.currentNodeId)).toBe("destination-node");
  await expect(dialog).toBeVisible();
  await page.evaluate(() => (window as any).finishConnection());
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/sessions\/destination$/);
  await expect(page.getByText("Moved conversation", { exact: true })).toBeVisible();
});

test("creation alone does not dismiss progress before the session is hydrated", async ({ page }) => {
  await page.evaluate(() => {
    const c = (window as any).forkController;
    // Simulate the coordinator's selection-loss recovery path: creation has
    // completed, but a subsequent node reset means history must be requested.
    c.sessionCoordinator.fork = async () => ({ sessionId: "destination", fidelity: "full", missing: [] });
    void c.forkSession("source");
  });
  const dialog = page.getByRole("dialog", { name: "Forking session" });
  await expect(dialog).toContainText("Loading the forked session");
  await expect(page).toHaveURL(/\/sessions\/source$/);
  await page.evaluate(() => {
    (window as any).forkController.store.apply({ type: "session.history", sessionId: "destination", runtimeId: "claude", messages: [{ role: "user", content: "History is ready" }] });
  });
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/sessions\/destination$/);
  await expect(page.getByText("History is ready", { exact: true })).toBeVisible();
});

test("fork failures stay in an actionable dialog instead of silently closing", async ({ page }) => {
  await page.getByRole("button", { name: "Claude", exact: true }).click();
  await page.getByRole("button", { name: /Codex/ }).click();
  await expect.poll(() => page.evaluate(() => (window as any).forkRequests.length)).toBe(1);
  await page.evaluate(() => {
    const c = (window as any).forkController;
    c.sessionCoordinator.handleEvent({ type: "error", requestId: (window as any).forkRequests[0].requestId, error: "Could not export working files" });
  });
  const dialog = page.getByRole("dialog", { name: "Fork needs attention" });
  await expect(dialog).toContainText("Could not export working files");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("Original conversation", { exact: true })).toBeVisible();
});
