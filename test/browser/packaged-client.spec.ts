// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "@playwright/test";
import { themes } from "./fixtures.js";
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
    define: { "import.meta.env.VITE_BIVY_CLIENT_CONFIG": JSON.stringify(JSON.stringify({
      version: 1, platform: "native", controlPlaneOrigin: cp, connectionMode: "account",
      authenticationMethods: ["email"], accountExtension: "hidden",
      signInDescription: "Sign in to your example workspace.",
      accountDeletionMessage: "Deleting this account does not stop those charges. Cancel store subscriptions separately.",
      accountMessageRules: [{ terms: ["upgrade", "purchase"], replacement: "This operation is not available for this account." }],
    })) },
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
    const state = globalThis as unknown as { __BIVY_PACKAGED_BRIDGE__: unknown; testFlushes: number; testForeground?: () => void; testExternal?: string; testLink?: (url: string) => void };
    state.testFlushes = 0;
    state.__BIVY_PACKAGED_BRIDGE__ = {
      storage, ready: async () => {}, flush: async () => { state.testFlushes++; },
      onForeground: (callback: () => void) => { state.testForeground = callback; return () => {}; },
      onOpenURL: (callback: (url: string) => void) => {
        state.testLink = callback;
        const cold = new URLSearchParams(location.search).get('testNativeLink');
        if (cold) callback(cold);
        return () => {};
      },
      openExternal: async (url: string) => { state.testExternal = url; },
    };
  });
});

test("native links queue behind sign-in without navigating to a remote page", async ({ page }) => {
  await page.goto(origin + '?testNativeLink=' + encodeURIComponent(cp + '/sessions/cold?node=node_1'));
  await expect(page.getByRole('textbox', { name: 'Email address' })).toBeVisible();
  await expect(page).toHaveURL(origin + '/sessions/cold');
  const deliver = (url: string) => page.evaluate(url => (globalThis as unknown as { testLink(url: string): void }).testLink(url), url);
  for (const bad of ['https://evil.example/sessions/a', cp + '/auth/device/start', cp + '/sessions/a?token=secret']) {
    await deliver(bad);
    await expect(page).toHaveURL(origin + '/sessions/cold');
  }
  await deliver(cp + '/sessions/warm?node=node_2');
  await expect(page).toHaveURL(origin + '/sessions/warm');
  await expect(page.getByRole('textbox', { name: 'Email address' })).toBeVisible();
  const opened = await page.evaluate(async cp => {
    const path = '/src/store/controller.ts';
    const { controller } = await import(path);
    const opened: unknown[] = [];
    controller.openSessionOnNode = (id: string, _title: unknown, node: string) => { opened.push([id, node]); };
    await controller.completeSignIn('native-link-session');
    if (opened.length) throw new Error('Link opened before a connection was available');
    controller.store.setStatus('online');
    controller.applyInitialRoute(); // Simulate transport readiness, not a real relay.
    (globalThis as unknown as { testLink(url: string): void }).testLink(cp + '/sessions/online?node=node_3');
    return opened;
  }, cp);
  expect(opened).toEqual([['warm', 'node_2'], ['online', 'node_3']]);
});

test("sign-in uses the regular themed Bivy mark instead of the tent emoji", async ({ page }, testInfo) => {
  await page.goto(origin);
  await expect(page.getByRole("textbox", { name: "Email address" })).toBeVisible();
  const logo = page.locator("svg.setup-logo");
  await expect(logo).toBeVisible();
  await expect(logo).toHaveAttribute("aria-hidden", "true");
  await expect(logo).toHaveAttribute("focusable", "false");
  await expect(page.getByRole("heading", { name: "Bivy", exact: true })).toHaveCount(1);
  await expect(page.locator(".setup-card")).not.toContainText("⛺");
  for (const theme of ["light", "dark"]) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    const colors = await logo.evaluate(element => ({
      ink: getComputedStyle(element).color,
      ridge: getComputedStyle(element.querySelector('path[stroke="currentColor"]')!).stroke,
      spark: getComputedStyle(element.querySelector("path")!).fill,
      accent: getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(),
    }));
    expect(colors.ridge).toBe(colors.ink);
    expect(colors.spark).not.toBe("none");
    expect(colors.accent).toBeTruthy();
    await page.screenshot({ path: testInfo.outputPath(`sign-in-${theme}.png`) });
  }
  await page.getByRole("textbox", { name: "Email address" }).focus();
  await expect(page.getByRole("textbox", { name: "Email address" })).toBeFocused();
});

for (const platform of ["native", "browser"]) {
  test(`generic ${platform} deployment preserves server login methods and account actions`, async ({ page }) => {
    const { createServer } = await import(pathToFileURL(require.resolve("vite")).href);
    const independent = await createServer({
      root: fileURLToPath(new URL("../../packages/web/", import.meta.url)),
      define: { "import.meta.env.VITE_BIVY_CLIENT_CONFIG": JSON.stringify(JSON.stringify({ platform, controlPlaneOrigin: cp, connectionMode: "account" })) },
      server: { host: "127.0.0.1", port: 0 }, logLevel: "error",
    });
    try {
      await independent.listen();
      await page.goto(new URL(independent.resolvedUrls!.local[0]).origin);
      await expect(page.getByText("Continue with GitHub", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Continue with email" })).toBeVisible();
      if (platform === "native") {
        await page.route(`${cp}/auth/device/github/start`, route => route.fulfill({ json: {
          deviceId: "github-id", deviceSecret: "github-secret", authorizeUrl: "https://signin.example.invalid/authorize", intervalMs: 50, expiresInMs: 5000,
        } }));
        await page.route(`${cp}/auth/device/poll`, route => route.fulfill({ json: { status: "pending" } }));
        await page.getByText("Continue with GitHub", { exact: true }).click();
        await expect.poll(() => page.evaluate(() => (globalThis as unknown as { testExternal: string }).testExternal)).toBe("https://signin.example.invalid/authorize");
        expect(page.context().pages()).toHaveLength(1);
        await page.getByRole("button", { name: "Cancel", exact: true }).click();
      }
      await page.evaluate(async () => {
        const controllerPath = "/src/store/controller.ts";
        await (await import(controllerPath)).controller.completeSignIn("generic-session");
        const settingsPath = "/src/settingsRoute.ts";
        (await import(settingsPath)).openSettings("account");
      });
      await expect(page.getByRole("button", { name: "Purchase now", exact: true })).toBeVisible();
      const secureWrites = await page.evaluate(() => (globalThis as unknown as { testFlushes: number }).testFlushes);
      expect(secureWrites > 0).toBe(platform === "native");
      if (platform === "native") {
        await page.evaluate(async () => {
          const path = "/src/packaged-client.ts";
          await (await import(path)).openAccountAction("https://account.example.invalid/manage");
        });
        expect(await page.evaluate(() => (globalThis as unknown as { testExternal: string }).testExternal)).toBe("https://account.example.invalid/manage");
      }
    } finally { await independent.close(); }
  });
}

for (const theme of themes) {
  test(`packaged sign-in is hosted, email-only, and uses the configured discovery origin (${theme})`, async ({ page }, testInfo) => {
    await page.addInitScript(theme => {
      localStorage.setItem("bivy_theme", theme);
      // Legacy room-only pairing data must not bypass packaged account login.
      const storage = (globalThis as unknown as { __BIVY_PACKAGED_BRIDGE__: { storage: Storage } }).__BIVY_PACKAGED_BRIDGE__.storage;
      storage.setItem("bivy_current", "old-node");
      storage.setItem("bivy_solo", JSON.stringify({ "old-node": { room: "old-room", roomToken: "old-token" } }));
    }, theme);
    await page.goto(`${origin}/?local=1`);
    await expect(page.getByRole("button", { name: "Continue with email" })).toBeVisible();
    await expect(page.getByText("Continue with GitHub")).toHaveCount(0);
    await expect(page.getByText("Sign in to your example workspace.")).toBeVisible();
    await expect(page.getByText("Buy a subscription")).toHaveCount(0);
    const config = await page.evaluate(async () => {
      const path = "/src/store/controller.ts";
      const { controller } = await import(path);
      return { direct: controller.direct, solo: controller.solo, cp: controller.local.cp, session: localStorage.getItem("bivy_session") };
    });
    expect(config).toEqual({ direct: false, solo: false, cp, session: null });
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

test("native subscription management is opt-in, account-scoped, and cleared at logout", async ({ page }) => {
  await page.goto(origin);
  await expect(page.getByRole("button", { name: "Continue with email" })).toBeVisible();
  await page.evaluate(async () => {
    const state = globalThis as unknown as {
      __BIVY_PACKAGED_BRIDGE__: { accountSubscriptions?: unknown };
      subscriptionCalls: unknown[];
    };
    state.subscriptionCalls = [];
    state.__BIVY_PACKAGED_BRIDGE__.accountSubscriptions = {
      open: async (account: unknown) => { state.subscriptionCalls.push(["open", account]); },
      synchronize: async (account: unknown) => { state.subscriptionCalls.push(["synchronize", account]); },
      clear: async () => { state.subscriptionCalls.push(["clear"]); },
    };
    const controllerPath = "/src/store/controller.ts";
    await (await import(controllerPath)).controller.completeSignIn("native-subscription-session");
    const settingsPath = "/src/settingsRoute.ts";
    (await import(settingsPath)).openSettings("account");
  });
  await page.getByRole("button", { name: "Manage subscriptions", exact: true }).click();
  await expect(page.getByRole("button", { name: "Manage subscriptions", exact: true })).toBeEnabled();
  await expect(page.getByText("Purchase now", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Delete account", exact: true }).click();
  await expect(page.getByText(/deleting this account does not stop those charges/i)).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  const calls = await page.evaluate(async () => {
    const path = "/src/store/controller.ts";
    await (await import(path)).controller.signOut();
    return (globalThis as unknown as { subscriptionCalls: unknown[] }).subscriptionCalls;
  });
  expect(calls).toContainEqual(["synchronize", { token: "native-subscription-session", controlPlane: cp }]);
  expect(calls).toContainEqual(["open", { token: "native-subscription-session", controlPlane: cp }]);
  expect(calls).toContainEqual(["clear"]);
});

test("native Notifications settings use the host lifecycle and clear it at logout", async ({ page }, testInfo) => {
  await page.goto(origin);
  await expect(page.getByRole('button', { name: 'Continue with email' })).toBeVisible();
  await page.evaluate(async () => {
    const state = globalThis as unknown as { __BIVY_PACKAGED_BRIDGE__: { notifications?: unknown }; notificationCalls: unknown[] };
    state.notificationCalls = [];
    Object.defineProperty(navigator, 'setAppBadge', { value: undefined });
    let subscribed = false;
    state.__BIVY_PACKAGED_BRIDGE__.notifications = {
      status: async () => ({ supported: true, subscribed, permission: 'granted' }),
      synchronize: async (account: unknown) => { state.notificationCalls.push(['sync', account]); },
      enable: async (account: unknown) => { subscribed = true; state.notificationCalls.push(['enable', account]); return 'Notifications enabled'; },
      disable: async () => { subscribed = false; return 'Notifications disabled'; },
      clear: async () => { state.notificationCalls.push(['clear']); },
    };
    const controllerPath = '/src/store/controller.ts';
    await (await import(controllerPath)).controller.completeSignIn('native-push-session');
    const settingsPath = '/src/settingsRoute.ts';
    (await import(settingsPath)).openSettings('notifications');
  });
  const toggle = page.getByRole('switch', { name: 'Enable push notifications', exact: true });
  await expect(toggle).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Show app icon badge' })).toHaveCount(0);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await page.screenshot({ path: testInfo.outputPath(`native-notifications-${theme}.png`) });
  }
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  const calls = await page.evaluate(async () => {
    const path = '/src/store/controller.ts';
    await (await import(path)).controller.signOut();
    return (globalThis as unknown as { notificationCalls: unknown[] }).notificationCalls;
  });
  expect(calls).toContainEqual(['sync', { token: 'native-push-session', controlPlane: cp }]);
  expect(calls).toContainEqual(['enable', { token: 'native-push-session', controlPlane: cp }]);
  expect(calls).toContainEqual(['clear']);
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

test("an obsolete secure-write failure does not erase a newer sign-in", async ({ page }) => {
  await page.goto(origin);
  await expect(page.getByRole("button", { name: "Continue with email" })).toBeVisible();
  const state = await page.evaluate(async () => {
    const native = (globalThis as unknown as { __BIVY_PACKAGED_BRIDGE__: { flush(): Promise<void> } }).__BIVY_PACKAGED_BRIDGE__;
    const path = "/src/store/controller.ts";
    const { controller } = await import(path);
    let failFirst!: () => void;
    let calls = 0;
    native.flush = () => ++calls === 1
      ? new Promise<void>((_, reject) => { failFirst = () => reject(new Error("write failed")); })
      : Promise.resolve();
    const first = controller.completeSignIn("obsolete").catch(() => {});
    await controller.completeSignIn("current");
    failFirst();
    await first;
    return controller.local.s;
  });
  expect(state).toBe("current");
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
