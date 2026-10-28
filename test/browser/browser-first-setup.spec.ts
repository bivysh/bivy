// SPDX-License-Identifier: MIT
import { expect, test, themes, type WebApp } from "./fixtures.js";

let server: WebApp;
let origin: string;
test.beforeAll(async ({ webApp }) => {
  server = webApp;
  origin = webApp.origin;
});

for (const theme of themes) {
  test(`first machine connects its AI and lands on the composer (${theme})`, async ({ page }, testInfo) => {
    page.on("pageerror", error => console.error(error.message));
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
    await expect(page.getByRole("button", { name: "Retry install command" })).toBeVisible({ timeout: 20000 });
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
    // Connected: sign in with the AI plans the user already pays for, on that machine.
    await expect(page.getByRole("heading", { name: "Connect your AI" })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("heading", { name: "Run this on your machine" })).toHaveCount(0);
    await expect(page.locator(".ai-account")).toHaveCount(2);
    await page.evaluate(async () => {
      const module = "/src/store/useStore.ts";
      const { controller } = await import(module);
      const w = window as unknown as { oauth: unknown[][] };
      w.oauth = [];
      controller.startOauth = (...args: unknown[]) => { w.oauth.push(args); };
    });
    await page.getByRole("button", { name: "Sign in with Claude" }).click();
    // No cloud chosen: the sign-in stays on this machine, out of the synced vault.
    const [provider, , sync] = await page.evaluate(() => (window as unknown as { oauth: unknown[][] }).oauth[0]);
    expect([provider, sync]).toEqual(["anthropic", "node"]);
    await page.evaluate(async () => {
      const module = "/src/store/useStore.ts";
      const { controller } = await import(module);
      controller.store.apply({ type: "providers.list", providers: [
        { id: "anthropic", name: "Anthropic", configured: true, oauth: true },
        { id: "openai-codex", name: "OpenAI Codex", oauth: true },
      ] });
    });
    await expect(page.locator(".ai-account-ok")).toHaveText("✓ Connected");
    await page.screenshot({ path: testInfo.outputPath(`connect-ai-${theme}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    // Connecting a plan is the last step: no Continue to press.
    await expect(page.getByRole("button", { name: "Continue" })).toHaveCount(0);
    await expect(page.getByRole("status", { name: "Setup readiness" })).toContainText("Validating the model credential", { timeout: 10_000 });
    await expect(page.getByRole("status", { name: "Setup readiness" })).not.toContainText("invalid");
    await page.evaluate(async () => {
      const module = "/src/store/useStore.ts";
      const { controller } = await import(module);
      controller.store.apply({ type: "activation.readiness", credential: { configured: true, probed: true, ok: true }, repository: { chosen: false, probed: true, ok: true, authed: false } });
    });
    // Setup done: the composer leads, with no suggested first task in front of it.
    await expect(page.getByRole("status", { name: "Setup readiness" })).toHaveCount(0);
    await expect(page.locator(".readiness")).toHaveCount(0);
    await expect(page.locator(".composer-input")).toHaveValue("");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`first-task-${theme}.png`), fullPage: true });
    // Cloud drafts must not show machine setup, even for an online account
    // with no prior sessions.
    for (const computeSource of ["managed", "user"]) {
      await page.evaluate(async (computeSource) => {
        const module = "/src/store/useStore.ts";
        const { controller } = await import(module);
        controller.store.setDraftEphemeralConfig({ id: "cloud", name: "Cloud", provider: "fly", computeSource, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      }, computeSource);
      await expect(page.getByRole("status", { name: "Setup readiness" })).toHaveCount(0);
      await expect(page.locator(".composer-input")).toHaveValue("");
      // The account-backed picker must be reachable before Cloud provisioning.
      await expect(page.locator(".model-pill")).toBeEnabled();
      await page.screenshot({ path: testInfo.outputPath(`cloud-draft-${computeSource}-${theme}.png`), fullPage: true });
      // Long selected model names may ellipsize, but must not widen the page.
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  });
}

for (const theme of themes) {
  test(`Bivy Cloud starts by default and signs in there (${theme})`, async ({ page }, testInfo) => {
    page.on("pageerror", error => console.error(error.message));
    await page.addInitScript((theme) => {
      localStorage.setItem("bivy_session", "sess_private_never_in_command");
      localStorage.setItem("bivy_cp", location.origin);
      localStorage.setItem("bivy_theme", theme);
    }, theme);
    for (const url of ["**/nodes", "**/account/**", "**/sessions", "**/devices"]) await page.route(url, route => route.fulfill({ json: [] }));
    await page.route("**/runtime-config.js", route => route.fulfill({ contentType: "application/javascript", body: "window.__BIVY_RUNTIME_CONFIG__ = { ephemeralMachinesEnabled: true };" }));
    await page.route("**/account/github/central-app", route => route.fulfill({ json: { configured: false, managedComputeAvailable: true, installations: [] } }));
    let installCommands = 0;
    await page.route("**/account/node-claims", route => { if (route.request().method() === "POST") installCommands++; return route.fulfill({ json: [] }); });
    let releaseMachine = () => {};
    const machineStarted = new Promise<void>((resolve) => { releaseMachine = resolve; });
    let runnerRequests = 0;
    await page.route("**/account/onboarding/auth-runner", async route => {
      runnerRequests++;
      await machineStarted;
      await route.fulfill({ status: 201, json: { ok: true, machine: { id: "eph-managed-auto-1", nodeId: "eph-managed-auto-1", provider: "fly", name: "Bivy Cloud", status: "launching", createdAt: new Date().toISOString(), computeSource: "managed", purpose: "auth-runner" } } });
    });
    await page.goto(origin);
    await page.evaluate(async () => {
      const module = "/src/store/useStore.ts";
      const { controller } = await import(module);
      const w = window as unknown as { oauth: unknown[][] };
      w.oauth = [];
      controller.startOauth = (...args: unknown[]) => {
        w.oauth.push(args);
        controller.store.apply({ type: "provider.oauth.started", id: "login", provider: args[0], status: "waiting", authUrl: "https://example.invalid/authorize", usesCallbackServer: true });
      };
      // The relay reports online only after this browser holds the room key.
      // Pairing is that moment; the auth-runner response carries no key.
      controller.connectToNode = async (id: string) => {
        controller.store.setCurrentNode(id);
        controller.store.setStatus("online");
        controller.store.apply({ type: "providers.list", providers: [
          { id: "anthropic", name: "Anthropic", oauth: true },
          { id: "openai-codex", name: "OpenAI Codex", oauth: true },
        ] });
      };
    });
    // No choice to make: the AI sign-in is on screen while the cloud machine starts.
    await expect(page.getByRole("heading", { name: "Connect your AI" })).toBeVisible({ timeout: 20_000 });
    // The install screen never flashed first (it would create an install command).
    expect(installCommands).toBe(0);
    await expect(page.getByRole("button", { name: "Use my own computer instead" })).toBeVisible();
    await expect(page.getByRole("status")).toContainText("Starting your cloud computer");
    await expect(page.getByRole("button", { name: "Sign in with Claude" })).toBeDisabled();
    await page.screenshot({ path: testInfo.outputPath(`connect-ai-starting-${theme}.png`), fullPage: true });
    releaseMachine();
    await expect(page.getByRole("button", { name: "Sign in with ChatGPT" })).toBeEnabled({ timeout: 10_000 });
    expect(runnerRequests).toBe(1);
    await page.getByRole("button", { name: "Sign in with ChatGPT" }).click();
    // On the cloud machine the sign-in joins the account vault. Nothing is sent as `sync`.
    const [provider, , sync] = await page.evaluate(() => (window as unknown as { oauth: unknown[][] }).oauth[0]);
    expect([provider, sync ?? null]).toEqual(["openai-codex", null]);
    await expect(page.getByText("Another machine that's online can restore it")).toBeVisible();
    // The open sign-in form makes the card tall; it scrolls inside the space above
    // the composer instead of running off the screen.
    await expect(page.getByRole("button", { name: "Submit" })).toBeVisible();
    await page.setViewportSize({ width: page.viewportSize()!.width, height: 600 });
    expect(await page.locator(".readiness").evaluate((card) => card.getBoundingClientRect().bottom <= innerHeight)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`connect-ai-cloud-${theme}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
