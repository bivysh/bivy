// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { expect, test } from "@playwright/test";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

// Render the real PWA, not a duplicated HTML fixture. Only remote account data
// and clipboard I/O are mocked; these tests do not claim live server enrollment.
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

for (const theme of ["light", "dark"] as const) {
  test(`portable browser owner setup and recovery (${theme})`, async ({ page }, testInfo) => {
    await page.addInitScript(({ selectedTheme }) => {
      localStorage.clear();
      localStorage.setItem("bivy_theme", selectedTheme);
    }, { selectedTheme: theme });
    let statusFailing = true;
    let passwordConfigured = false;
    let setupRequired = true;
    await page.route("**/auth/owner/status", async (route) => {
      if (statusFailing) return route.fulfill({ status: 503, json: { error: "offline" } });
      await route.fulfill({ json: { enabled: true, passwordConfigured, setupRequired, github: false, email: false } });
    });
    let setupAttempts = 0;
    await page.route("**/auth/owner/setup", async (route) => {
      const input = route.request().postDataJSON();
      expect(input.password).toBe("a strong owner password");
      expect(route.request().url()).not.toContain(input.setupToken);
      if (++setupAttempts === 1) return route.fulfill({ status: 401, json: { error: "Invalid or already-used setup secret." } });
      passwordConfigured = true; setupRequired = false;
      await route.fulfill({ json: { token: "sess_browser_owner", relayUrl: "wss://portable.example/relay" } });
    });
    for (const route of ["**/nodes", "**/account/**", "**/sessions", "**/devices"]) await page.route(route, (request) => request.fulfill({ json: [] }));
    // Force remote/PWA mode on the loopback Vite test host without a session.
    await page.goto(`${origin}/#payload=`);
    await expect(page.getByRole("alert")).toContainText("Could not reach your server");
    statusFailing = false;
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Set up owner access" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Continue with GitHub" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Continue with email" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Save password and continue" })).toBeDisabled();
    await page.getByLabel("Setup secret", { exact: true }).fill("a".repeat(64));
    await page.getByLabel("New password", { exact: true }).fill("a strong owner password");
    await page.getByLabel("Confirm password", { exact: true }).fill("does not match");
    await page.getByRole("button", { name: "Save password and continue" }).click();
    await expect(page.getByRole("alert")).toHaveText("Passwords do not match.");
    expect(setupAttempts).toBe(0);
    await page.getByLabel("Confirm password", { exact: true }).fill("a strong owner password");
    await page.getByRole("button", { name: "Save password and continue" }).click();
    await expect(page.getByRole("alert")).toHaveText("Invalid or already-used setup secret.");
    await page.getByLabel("Setup secret", { exact: true }).focus();
    await expect(page.getByLabel("Setup secret", { exact: true })).toBeFocused();
    // Canonical .field uses an accent box-shadow focus ring rather than outline.
    expect(await page.getByLabel("Setup secret", { exact: true }).evaluate(el => getComputedStyle(el).boxShadow)).not.toBe("none");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (testInfo.project.name === "mobile") {
      for (const input of await page.locator(".setup-email input").all()) expect(await input.evaluate(el => Number.parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
      expect((await page.getByRole("button", { name: "Save password and continue" }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    await page.screenshot({ path: testInfo.outputPath(`owner-setup-${theme}.png`), fullPage: true });
    await page.getByRole("button", { name: "Save password and continue" }).click();
    await expect(page.getByRole("heading", { name: "Connect a Machine", exact: true }).last()).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("bivy_relay"))).toBe("wss://portable.example/relay");

    // A rotated deployment token offers recovery without removing normal login.
    setupRequired = true;
    await page.goto(`${origin}/?owner-recovery=1#payload=`);
    await expect(page.getByRole("heading", { name: "Owner sign-in" })).toBeVisible();
    const recovery = page.getByText("Forgot your password?", { exact: true });
    await recovery.focus();
    await page.keyboard.press("Enter");
    await expect(recovery).toBeFocused();
    expect(await recovery.evaluate(el => getComputedStyle(el).outlineStyle)).not.toBe("none");
    if (testInfo.project.name === "mobile") expect((await recovery.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: testInfo.outputPath(`owner-login-${theme}.png`), fullPage: true });
    await page.getByRole("button", { name: "Reset owner password" }).click();
    await expect(page.getByLabel("Setup secret", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Back to password sign-in" }).click();
    await expect(page.getByLabel("Setup secret", { exact: true })).toHaveCount(0);
    await page.route("**/auth/owner/login", route => route.fulfill({ json: { token: "sess_password_login", relayUrl: "wss://portable.example/relay" } }));
    await page.getByLabel("Password", { exact: true }).fill("a strong owner password");
    await page.getByRole("button", { name: "Sign in as owner" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Connect a Machine", exact: true }).last()).toBeVisible();
  });
  test(`self-host owner can copy a correctly scoped machine command (${theme})`, async ({ page }, testInfo) => {
    await page.addInitScript(({ selectedTheme }) => {
      localStorage.setItem("bivy_session", "sess_fixture_" + "long-token-".repeat(12));
      localStorage.setItem("bivy_cp", location.origin);
      localStorage.setItem("bivy_relay", "wss://very-long-self-hosted-domain.example/relay");
      localStorage.setItem("bivy_theme", selectedTheme);
      Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text: string) => { (window as unknown as { copied: string }).copied = text; } } });
    }, { selectedTheme: theme });
    for (const route of ["**/nodes", "**/account/**", "**/sessions", "**/devices"]) {
      await page.route(route, (request) => request.fulfill({ json: [] }));
    }
    await page.goto(origin);
    await expect(page.getByRole("heading", { name: "Connect a Machine", exact: true }).last()).toBeVisible();
    await expect(page.getByText("Both commands connect to your self-hosted server.", { exact: false })).toBeVisible();
    const auto = page.getByRole("button", { name: "Copy auto sign-in command", exact: true });
    await auto.focus();
    await expect(auto).toBeFocused();
    expect(await auto.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Auto sign-in command copied", exact: true })).toBeVisible();
    const copied = await page.evaluate(() => (window as unknown as { copied: string }).copied);
    expect(copied).toContain("https://bivy.sh/install.sh | BIVY_SESSION_TOKEN=sess_fixture_");
    expect(copied).toContain(`BIVY_CONTROL_PLANE_URL=${origin}`);
    expect(copied).toContain("BIVY_RELAY_URL=wss://very-long-self-hosted-domain.example/relay bash");
    await page.getByRole("button", { name: "Copy regular sign-in command", exact: true }).click();
    const plain = await page.evaluate(() => (window as unknown as { copied: string }).copied);
    expect(plain).not.toContain("BIVY_SESSION_TOKEN");
    expect(plain).toContain(`BIVY_CONTROL_PLANE_URL=${origin}`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (testInfo.project.name === "mobile") {
      const box = await auto.boundingBox();
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    await page.screenshot({ path: testInfo.outputPath(`self-host-${theme}.png`), fullPage: true });
  });
}
