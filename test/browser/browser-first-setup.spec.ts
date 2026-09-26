// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, themes, type WebApp } from "./fixtures.js";

let server: WebApp;
let origin: string;
test.beforeAll(async ({ webApp }) => {
  server = webApp;
  origin = webApp.origin;
});

for (const theme of themes) {
  test(`first machine advances automatically and starter task remains explicit (${theme})`, async ({ page }, testInfo) => {
    await page.addInitScript((theme) => {
      localStorage.setItem("bivy_session", "sess_private_never_in_command");
      localStorage.setItem("bivy_cp", location.origin);
      localStorage.setItem("bivy_theme", theme);
    }, theme);
    for (const url of ["**/nodes", "**/account/**", "**/sessions", "**/devices"]) await page.route(url, route => route.fulfill({ json: [] }));
    let mode = "error";
    let created = 0;
    const claim = { id: "one", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString(), status: "pending", command: `curl -fsSL https://bivy.sh/install.sh | BIVY_NODE_CLAIM_CODE=${"x".repeat(43)} BIVY_CONTROL_PLANE_URL=${origin} bash` };
    await page.route("**/account/node-claims", route => {
      if (route.request().method() === "POST") {
        created++;
        return mode === "error" ? route.fulfill({ status: 503, json: {} }) : route.fulfill({ json: claim });
      }
      return route.fulfill({ json: [{ ...claim, status: mode === "expired" ? "expired" : "pending" }] });
    });
    // Keep all polling behavior, but do not wait through real refresh intervals.
    await page.clock.install();
    await page.goto(origin);
    await expect(page.getByRole("button", { name: "Retry install command" })).toBeVisible();
    mode = "pending";
    await page.getByRole("button", { name: "Retry install command" }).click();
    await expect(page.getByRole("button", { name: "Copy install command", exact: true })).toBeVisible();
    expect(created).toBe(2);
    await expect(page.locator(".machine-install-instructions")).not.toContainText("sess_private");
    mode = "expired";
    await page.clock.runFor(5000);
    await expect(page.getByRole("button", { name: "Create new install command" })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("button", { name: "Copy install command", exact: true })).toHaveCount(0);
    mode = "pending";
    await page.getByRole("button", { name: "Create new install command" }).click();
    await expect(page.getByRole("button", { name: "Copy install command", exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`connect-${theme}.png`), fullPage: true });
    // Real App and store, with only machine transport/catalog I/O substituted.
    // Enrollment/service startup itself requires a live host and isn't simulated
    // by this test. The refresh effect must discover and select the machine.
    await page.evaluate(async () => {
      const module = "/src/store/useStore.ts";
      const { controller } = await import(module);
      controller.switchNode = (id: string) => {
        controller.store.setCurrentNode(id);
        controller.store.setStatus("online");
        const agent = { id: "claude-code-sdk", name: "Claude Code", status: "available", supportTier: "supported" };
        controller.store.apply({ type: "runtimes.list", runtimes: [agent], current: agent });
        controller.store.apply({ type: "activation.readiness", credential: { configured: true, providers: ["anthropic"], probed: true, ok: true }, repository: { chosen: false, probed: true, ok: false, authed: true } });
        controller.store.apply({ type: "repos.list", authed: true, repos: [
          { slug: "example/a-repository-with-a-deliberately-long-name", description: "Your existing project" },
          { slug: "example/api" },
        ] });
      };
      controller.chooseRepo = (repo: string) => controller.store.setDraftRepo(repo);
    });
    await page.route("**/nodes", route => route.fulfill({ json: [{ id: "first-machine", name: "My laptop", online: false }] }));
    await page.clock.runFor(5000);
    await expect(page.getByRole("button", { name: /My laptop/ })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("heading", { name: "Run this on your machine" })).toBeVisible();
    await page.route("**/nodes", route => route.fulfill({ json: [{ id: "first-machine", name: "My laptop", online: true }] }));
    await page.clock.runFor(5000);
    await expect(page.getByRole("button", { name: "Use starter task" })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("heading", { name: "Run this on your machine" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "example/api", exact: true })).toBeVisible();
    await expect(page.getByRole("status", { name: "Setup readiness" })).toContainText("4 setup checks complete");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`first-task-${theme}.png`), fullPage: true });
    // Cloud drafts must not show the starter prompt, even for an online account
    // with no prior sessions. Switching back preserves first-machine onboarding.
    for (const computeSource of ["managed", "user"]) {
      await page.evaluate(async (computeSource) => {
        const module = "/src/store/useStore.ts";
        const { controller } = await import(module);
        controller.store.setDraftEphemeralConfig({ id: "cloud", name: "Cloud", provider: "fly", computeSource, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      }, computeSource);
      await expect(page.getByRole("button", { name: "Use starter task" })).toHaveCount(0);
      await expect(page.getByText("Start with a small task", { exact: true })).toHaveCount(0);
      await expect(page.getByRole("status", { name: "Setup readiness" })).toHaveCount(0);
      await expect(page.locator(".composer-input")).toHaveValue("");
      // The account-backed picker must be reachable before Cloud provisioning.
      await expect(page.locator(".model-pill")).toBeEnabled();
      await page.screenshot({ path: testInfo.outputPath(`cloud-draft-${computeSource}-${theme}.png`), fullPage: true });
      // Long selected model names may ellipsize, but must not widen the page.
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await page.evaluate(async () => {
      const module = "/src/store/useStore.ts";
      const { controller } = await import(module);
      controller.store.setDraftEphemeralConfig(null);
    });
    await page.getByRole("button", { name: "example/api", exact: true }).click();
    await expect(page.locator(".repo-pill")).toContainText("example/api");
    await page.getByRole("button", { name: "Use starter task" }).click();
    await expect(page.locator(".composer-input")).toHaveValue("Inspect this repository and explain how to run its tests. Do not change files.");
    await expect(page.locator(".composer-input")).toBeFocused();
    await page.locator(".composer-input").fill("Explain the API authentication flow instead.");
    await expect(page.locator(".composer-input")).toHaveValue("Explain the API authentication flow instead.");
  });
}
