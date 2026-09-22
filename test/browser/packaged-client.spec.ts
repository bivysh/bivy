// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "@playwright/test";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(new URL("../../packages/web/package.json", import.meta.url));
let server: { listen(): Promise<unknown>; close(): Promise<void>; resolvedUrls: { local: string[] } | null };
let origin: string;
const cp = "https://packaged.example.invalid";
test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  const { createServer } = await import(pathToFileURL(require.resolve("vite")).href);
  server = await createServer({
    root: fileURLToPath(new URL("../../packages/web/", import.meta.url)),
    define: { "import.meta.env.VITE_BIVY_PACKAGED_CP": JSON.stringify(cp) },
    server: { host: "127.0.0.1", port: 0 }, logLevel: "error",
  });
  await server.listen();
  origin = new URL(server.resolvedUrls!.local[0]).origin;
});
test.afterAll(async () => { await server?.close(); });

test.beforeEach(async ({ page }) => {
  await page.route(`${cp}/**`, route => {
    const url = new URL(route.request().url());
    const json = url.pathname === "/auth/owner/status"
      ? { enabled: false, passwordConfigured: false, setupRequired: false, github: true, email: true }
      : url.pathname === "/me"
        ? { account: { email: "test@example.invalid" }, counts: { nodes: 0, devices: 0, sessions: 0 }, extension: { title: "Buy a subscription", actions: [{ id: "checkout", label: "Purchase now" }] } }
        : [];
    return route.fulfill({ json });
  });
  await page.addInitScript(() => {
    const values = new Map<string, string>();
    const storage: Storage = {
      get length() { return values.size; },
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, String(value)); },
      removeItem: key => { values.delete(key); },
      clear: () => values.clear(), key: index => [...values.keys()][index] ?? null,
    };
    const state = globalThis as unknown as { __BIVY_PACKAGED_BRIDGE__: unknown; testFlushes: number; testForeground?: () => void; testExternal?: string };
    state.testFlushes = 0;
    state.__BIVY_PACKAGED_BRIDGE__ = {
      storage, ready: async () => {}, flush: async () => { state.testFlushes++; },
      onForeground: (callback: () => void) => { state.testForeground = callback; return () => {}; },
      openExternal: async (url: string) => { state.testExternal = url; },
    };
  });
});

for (const theme of ["light", "dark"]) {
  test(`packaged sign-in is hosted, email-only, and uses the configured discovery origin (${theme})`, async ({ page }, testInfo) => {
    await page.addInitScript(theme => localStorage.setItem("bivy_theme", theme), theme);
    await page.goto(`${origin}/?local=1`);
    await expect(page.getByRole("button", { name: "Continue with email" })).toBeVisible();
    await expect(page.getByText("Continue with GitHub")).toHaveCount(0);
    await expect(page.getByText("Buy a subscription")).toHaveCount(0);
    const config = await page.evaluate(async () => {
      const path = "/src/store/controller.ts";
      const { controller } = await import(path);
      return { direct: controller.direct, cp: controller.local.cp, session: localStorage.getItem("bivy_session") };
    });
    expect(config).toEqual({ direct: false, cp, session: null });
    expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
    await page.getByRole("link", { name: "Terms", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (globalThis as unknown as { testExternal: string }).testExternal)).toBe("https://bivy.sh/terms.html");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
    await page.screenshot({ path: testInfo.outputPath(`packaged-signin-${theme}.png`), fullPage: true });
  });
}

test("email completion persists via bridge, hides dynamic purchase actions, and retains deletion", async ({ page }) => {
  await page.route(`${cp}/auth/device/start`, route => route.fulfill({ json: { deviceId: "test-id", deviceSecret: "test-secret", intervalMs: 50, expiresInMs: 5000, sent: true } }));
  let polls = 0;
  await page.route(`${cp}/auth/device/poll`, route => ++polls === 1 ? route.abort() : route.fulfill({ json: { status: "complete", token: "test-only-bearer" } }));
  await page.goto(origin);
  await page.getByPlaceholder("you@example.com").fill("test@example.invalid");
  await page.getByRole("button", { name: "Continue with email" }).click();
  await expect.poll(() => page.evaluate(async () => {
    const path = "/src/store/controller.ts";
    return (await import(path)).controller.local.s;
  })).toBe("test-only-bearer");
  const state = await page.evaluate(async () => {
    const path = "/src/store/controller.ts";
    const settingsPath = "/src/settingsRoute.ts";
    const { controller } = await import(path);
    (await import(settingsPath)).openSettings("account");
    controller.store.setError("Upgrade to proceed", [{ id: "checkout", label: "Buy subscription" }]);
    let blocked = false;
    try { await controller.invokeAccountExtensionAction("checkout"); } catch { blocked = true; }
    return { token: controller.local.s, insecureToken: localStorage.getItem("bivy_session"), blocked };
  });
  expect(state).toEqual({ token: "test-only-bearer", insecureToken: null, blocked: true });
  await expect(page.getByRole("button", { name: "Delete account", exact: true })).toBeVisible();
  await expect(page.getByText("Purchase now", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Buy subscription", { exact: true })).toHaveCount(0);
  await expect(page.getByText("This operation is not available for this account.", { exact: true })).toBeVisible();
});

test("cancellation ignores an in-flight email completion", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let polling = false;
  await page.route(`${cp}/auth/device/start`, route => route.fulfill({ json: { deviceId: "id", deviceSecret: "secret", intervalMs: 50, expiresInMs: 5000, sent: true } }));
  await page.route(`${cp}/auth/device/poll`, async route => {
    polling = true;
    await gate;
    await route.fulfill({ json: { status: "complete", token: "cancelled-token" } });
  });
  await page.goto(origin);
  await page.getByRole("textbox", { name: "Email address" }).fill("test@example.invalid");
  await page.getByRole("button", { name: "Continue with email" }).click();
  await expect.poll(() => polling).toBe(true);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  const response = page.waitForResponse(`${cp}/auth/device/poll`);
  release();
  await response;
  await expect(page.getByRole("button", { name: "Continue with email" })).toBeVisible();
  expect(await page.evaluate(async () => {
    const path = "/src/store/controller.ts";
    return (await import(path)).controller.local.s;
  })).toBe("");
});

test("failed secure persistence does not complete sign-in or leak the bridge error", async ({ page }) => {
  await page.goto(origin);
  await expect(page.getByRole("button", { name: "Continue with email" })).toBeVisible();
  const state = await page.evaluate(async () => {
    const native = (globalThis as unknown as { __BIVY_PACKAGED_BRIDGE__: { flush(): Promise<void> } }).__BIVY_PACKAGED_BRIDGE__;
    native.flush = async () => { throw new Error("private platform detail"); };
    const path = "/src/store/controller.ts";
    const { controller } = await import(path);
    let message = "";
    try { await controller.completeSignIn("must-not-persist"); } catch (error) { message = (error as Error).message; }
    return { message, token: controller.local.s, local: localStorage.getItem("bivy_session") };
  });
  expect(state).toEqual({ message: "Could not save the account securely. Please try again.", token: "", local: null });
  await expect(page.getByRole("button", { name: "Continue with email" })).toBeVisible();
});

test("a saved account from another control plane fails closed", async ({ page }) => {
  await page.addInitScript(() => {
    const native = (globalThis as unknown as { __BIVY_PACKAGED_BRIDGE__: { storage: Storage } }).__BIVY_PACKAGED_BRIDGE__;
    native.storage.setItem("bivy_cp", "https://other.example.invalid");
    native.storage.setItem("bivy_session", "other-account-token");
  });
  await page.goto(origin);
  await expect(page.getByRole("alert")).toContainText("could not initialize safely");
  await expect(page.getByRole("button", { name: "Continue with email" })).toHaveCount(0);
});

test("missing native storage bridge fails closed with an accessible retry", async ({ page }) => {
  await page.addInitScript(() => { delete (globalThis as unknown as { __BIVY_PACKAGED_BRIDGE__?: unknown }).__BIVY_PACKAGED_BRIDGE__; });
  await page.goto(origin);
  await expect(page.getByRole("alert")).toContainText("could not initialize safely");
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue with email" })).toHaveCount(0);
});
