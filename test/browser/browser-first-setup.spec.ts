// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, themes, type WebApp } from "./fixtures.js";

let server: WebApp;
let origin: string;
test.beforeAll(async ({ webApp }) => {
  server = webApp;
  origin = webApp.origin;
});

for (const theme of themes) {
  test(`first machine advances to a first task that runs the loop (${theme})`, async ({ page }, testInfo) => {
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
      // The machine's running servers, before any session exists; none at first.
      const w = window as unknown as { offers: unknown[]; sent: unknown[][] };
      w.offers = []; w.sent = [];
      controller.appCommand = async (kind: string) => kind === "apps.offers" ? { offers: w.offers } : {};
      controller.pushStatus = async () => ({ supported: false, subscribed: false, permission: "default" });
      controller.sendPrompt = (...args: unknown[]) => { w.sent.push(args); };
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
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("status", { name: "Setup readiness" })).toContainText("Validating the model credential", { timeout: 10_000 });
    await expect(page.getByRole("status", { name: "Setup readiness" })).not.toContainText("invalid");
    await page.evaluate(async () => {
      const module = "/src/store/useStore.ts";
      const { controller } = await import(module);
      controller.store.apply({ type: "activation.readiness", credential: { configured: true, probed: true, ok: true }, repository: { chosen: false, probed: true, ok: true, authed: false } });
    });
    await expect(page.getByRole("heading", { name: "Give your agent a first task" })).toBeVisible();
    await expect(page.getByRole("status", { name: "Setup readiness" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Use starter task" })).toHaveCount(0);
    await expect(page.locator(".composer-input")).toHaveValue("");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`first-task-${theme}.png`), fullPage: true });
    // Cloud drafts must not show machine setup, even for an online account
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
    await expect(page.getByRole("heading", { name: "Give your agent a first task" })).toBeVisible();
    await page.locator(".composer-input").focus();
    await expect(page.locator(".composer-input")).toBeFocused();
    await page.locator(".composer-input").fill("Explain the API authentication flow instead.");
    await expect(page.locator(".composer-input")).toHaveValue("Explain the API authentication flow instead.");
    // Nothing running: one tap asks for a small change, reported back by push.
    await page.getByRole("button", { name: "Make one small improvement" }).click();
    expect(await page.evaluate(() => (window as unknown as { sent: string[][] }).sent[0][0])).toMatch(/^I'm new to Bivy\. Make one small, useful change/);
    // A dev server running on the machine becomes the first task: the session
    // starts in the app's own folder, not the draft repository.
    await page.evaluate(async () => {
      const module = "/src/store/useStore.ts";
      const { controller } = await import(module);
      (window as unknown as { offers: unknown[] }).offers = [{ port: 5173, pid: 42, command: "node vite --port 5173", project: "/home/me/code/shop" }];
      controller.store.setDraftEphemeralConfig({ id: "cloud", name: "Cloud", provider: "fly", computeSource: "managed", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    });
    await expect(page.getByRole("heading", { name: "Give your agent a first task" })).toHaveCount(0);
    await page.evaluate(async () => {
      const module = "/src/store/useStore.ts";
      const { controller } = await import(module);
      controller.store.setDraftEphemeralConfig(null);
    });
    await expect(page.getByRole("heading", { name: "Mark what's wrong in shop" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`first-task-app-${theme}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole("button", { name: "Open shop and mark what's wrong" }).click();
    const [text, , start] = await page.evaluate(() => (window as unknown as { sent: unknown[][] }).sent[1]) as [string, unknown, Record<string, unknown>];
    expect(text).toContain("port 5173");
    expect(start).toMatchObject({ workspace: "/home/me/code/shop" });
  });
}

for (const theme of themes) {
  test(`choosing Bivy Cloud starts the cloud machine and signs in there (${theme})`, async ({ page }, testInfo) => {
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
      await route.fulfill({ status: 201, json: { ok: true, roomKey: "a".repeat(43), machine: { id: "eph-managed-auto-1", nodeId: "eph-managed-auto-1", provider: "fly", name: "Bivy Cloud", status: "launching", createdAt: new Date().toISOString(), computeSource: "managed", purpose: "auth-runner" } } });
    });
    await page.goto(origin);
    await page.evaluate(async () => {
      const module = "/src/store/useStore.ts";
      const { controller } = await import(module);
      const w = window as unknown as { oauth: unknown[][] };
      w.oauth = [];
      controller.startOauth = (...args: unknown[]) => { w.oauth.push(args); };
      // The relay connection itself needs a live machine; the store sees it come online.
      controller.connectToNode = async (id: string) => {
        controller.store.setCurrentNode(id);
        controller.store.setStatus("online");
        controller.store.apply({ type: "providers.list", providers: [
          { id: "anthropic", name: "Anthropic", oauth: true },
          { id: "openai-codex", name: "OpenAI Codex", oauth: true },
        ] });
      };
    });
    await expect(page.getByRole("heading", { name: "Where should your agents run?" })).toBeVisible({ timeout: 20_000 });
    // The install screen never flashed before the choice (it would create an install command).
    expect(installCommands).toBe(0);
    await page.screenshot({ path: testInfo.outputPath(`place-choice-${theme}.png`), fullPage: true });
    await page.getByRole("button", { name: /Bivy Cloud/ }).click();
    // The AI sign-in is on screen while the machine starts.
    await expect(page.getByRole("heading", { name: "Connect your AI" })).toBeVisible();
    await expect(page.getByRole("status")).toContainText("Starting your cloud computer");
    await expect(page.getByRole("button", { name: "Sign in with Claude" })).toBeDisabled();
    await page.screenshot({ path: testInfo.outputPath(`connect-ai-starting-${theme}.png`), fullPage: true });
    releaseMachine();
    await expect(page.getByRole("button", { name: "Sign in with ChatGPT" })).toBeEnabled({ timeout: 10_000 });
    expect(runnerRequests).toBe(1);
    await page.getByRole("button", { name: "Sign in with ChatGPT" }).click();
    // On the cloud machine the sign-in uses the account default, which cloud runs need.
    const [provider, , sync] = await page.evaluate(() => (window as unknown as { oauth: unknown[][] }).oauth[0]);
    expect([provider, sync ?? null]).toEqual(["openai-codex", null]);
    await expect(page.getByText("Bivy keeps a copy")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`connect-ai-cloud-${theme}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
