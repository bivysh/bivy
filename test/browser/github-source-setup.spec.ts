// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from "./fixtures.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type ViteDevServer } from "../../packages/web/node_modules/vite/dist/node/index.js";
import { githubSourceStatus, githubMentionHandles, githubInstallationSettings } from "../../packages/web/src/components/githubSource.js";

const installation = { installationId: "42", githubAccount: "acme", githubAccountType: "Organization", createdAt: "2026-09-01" };
const hosted = { connected: true, appId: "123", central: true, hosted: true, installed: true, mention: "bivy-hosted", name: "Hosted Bivy App", servedBy: null, installations: [installation] };
const custom = { connected: true, appId: "456", installed: true, mention: "acme-bot", name: "Acme custom app", servedBy: null };
let server: ViteDevServer;
let origin: string;
let cacheDir: string;

test.beforeAll(async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../packages/web");
  // Other browser suites start Vite concurrently. Give each worker its own
  // optimizer cache instead of racing their dependency-bundle rewrites.
  cacheDir = await mkdtemp(path.join(root, "node_modules/.vite-source-"));
  server = await createServer({ root, cacheDir, logLevel: "silent", server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  const address = server.httpServer!.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await server?.close(); if (cacheDir) await rm(cacheDir, { recursive: true, force: true }); });

test("connection status does not conflate hosted installation with executor readiness", () => {
  expect(githubSourceStatus({ connected: true, apps: [hosted] })).toMatchObject({ tone: "on", label: "Hosted Bivy App connected" });
  expect(githubSourceStatus({ connected: true, apps: [custom] }).label).toBe("Custom GitHub App connected");
  expect(githubSourceStatus({ connected: true, apps: [hosted, custom] }).label).toBe("Hosted + custom apps connected");
  expect(githubSourceStatus(null).label).toBe("Status unavailable");
  expect(githubSourceStatus({ connected: false, apps: [] }).tone).toBe("off");
  expect(githubMentionHandles({ connected: true, apps: [hosted, custom] })).toEqual(["bivy-hosted", "acme-bot"]);
  expect(githubMentionHandles({ connected: true, apps: [hosted, custom] }, "456")).toEqual(["acme-bot"]);
  expect(githubMentionHandles(null)).toEqual([]);
  expect(githubInstallationSettings(installation)).toBe("https://github.com/organizations/acme/settings/installations/42");
  expect(githubInstallationSettings({ ...installation, githubAccountType: "User" })).toBe("https://github.com/settings/installations/42");
});

async function openSetup(page: Page, theme: string, focus = "github", apps: Array<typeof hosted | typeof custom> = [hosted], fail = false, centralConfigured = true) {
  await page.route("**/account/**", (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const json = pathname === "/account/github-app" ? { connected: apps.length > 0, apps }
      : ["/account/automations", "/account/automation-runs"].includes(pathname) ? []
      : { enabled: false, execution: { ready: false } };
    return route.fulfill({ json });
  });
  await page.route("**/nodes", (route) => route.fulfill({ json: [] }));
  const fixturePath = `/source-test-${theme}-${focus}-${apps.map((entry) => entry.appId).join("-")}-${fail}-${centralConfigured}`;
  const html = await server.transformIndexHtml(fixturePath, `<html data-theme="${theme}"><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module">
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { WorkQueueSetupSheet } from '/src/components/WorkQueueSetupSheet.tsx';
    import { AutomationsView } from '/src/components/AutomationsView.tsx';
    import { controller } from '/src/store/controller.ts';
    import '/@fs/${path.resolve("packages/ui/tokens.css")}';
    import '/src/styles.css';
    import '/src/ux-cleanup.css';
    controller.direct = false;
    controller.local.s = 'test-session';
    controller.local.cp = ${JSON.stringify(origin)};
    controller.fetchMe = async () => null;
    controller.fetchGithubApp = async () => { ${fail ? 'throw new Error("Connection failed");' : `return ${JSON.stringify({ connected: apps.length > 0, apps })};`} };
    controller.listNodes = async () => [];
    controller.centralGithubApp = async () => ({ configured: ${centralConfigured}, installations: [] });
    const state = controller.store.getState();
    createRoot(document.getElementById('root')).render(${focus === "automations"
      ? `React.createElement(AutomationsView, { state, section: null, onSectionChange: () => {}, onOpenSession: () => {}, onClose: () => {} })`
      : `React.createElement(WorkQueueSetupSheet, { state, focus: ${JSON.stringify(focus)}, onClose: () => document.getElementById('root').textContent = 'Closed' })`});
  </script></body></html>`);
  await page.route(`${origin}${fixturePath}`, (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto(`${origin}${fixturePath}`);
}

for (const theme of ["light", "dark"]) {
  test(`hosted GitHub setup is separate, actionable, and explicit (${theme})`, async ({ page }, testInfo) => {
    await openSetup(page, theme);
    const dialog = page.getByRole("dialog", { name: "Manage GitHub Apps" });
    await expect(dialog.getByText("Connected", { exact: true })).toBeVisible();
    await expect(dialog).not.toContainText("Linear");
    await expect(dialog).not.toContainText("Work issues into PRs");
    await expect(dialog).not.toContainText("No GitHub App yet");
    await expect(dialog).toContainText("@bivy-hosted");
    await expect(dialog).toContainText("Labels are configurable per automation");
    await expect(dialog.getByLabel("Trigger labels", { exact: true })).toHaveCount(0);
    await expect(dialog).not.toContainText("Default label trigger");
    const manage = dialog.getByRole("link", { name: "Configure / uninstall · acme" });
    await expect(manage).toHaveAttribute("href", "https://github.com/organizations/acme/settings/installations/42");
    await manage.focus();
    await expect(manage).toBeFocused();
    await expect(dialog.getByRole("button", { name: "Add another account or organization" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`github-${theme}.png`), fullPage: true });
    await page.keyboard.press("Escape");
    await expect(page.getByText("Closed", { exact: true })).toBeVisible();
  });
}

for (const theme of ["light", "dark"]) {
  for (const configured of [true, false]) {
    test(`hosted management stays available with configured=${configured} (${theme})`, async ({ page }, testInfo) => {
      await openSetup(page, theme, "github", [custom], false, configured);
      const install = page.getByRole("button", { name: "Install hosted Bivy App" });
      if (configured) await expect(install).toBeEnabled();
      else await expect(install).toBeDisabled();
      const manage = page.getByRole("link", { name: "Manage hosted app access on GitHub" });
      await expect(manage).toHaveAttribute("href", "https://github.com/settings/installations");
      await expect(manage).toHaveAttribute("target", "_blank");
      await manage.focus();
      await expect(manage).toBeFocused();
      await expect(page.getByText("For organization installations", { exact: false })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`hosted-management-${theme}-${configured}.png`), fullPage: true });
    });
  }
}

test("unconnected GitHub offers hosted installation, not just custom app creation", async ({ page }) => {
  await openSetup(page, "light", "github", []);
  await expect(page.getByRole("button", { name: "Install hosted Bivy App" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create GitHub App", exact: true })).toBeHidden();
  await page.getByText("Use your own GitHub App", { exact: true }).click();
  await expect(page.getByText("No custom GitHub App connected.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create GitHub App", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect an existing app instead" })).toBeVisible();
});

test("failed status fetch does not claim no app exists", async ({ page }) => {
  await openSetup(page, "light", "github", [], true);
  await expect(page.getByRole("alert")).toContainText("Connection failed");
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(page.getByText("No custom GitHub App connected.", { exact: false })).toHaveCount(0);
});

test("Linear setup does not include GitHub", async ({ page }) => {
  await openSetup(page, "light", "linear");
  const dialog = page.getByRole("dialog", { name: "Connect Linear" });
  await expect(dialog).toBeVisible();
  await expect(dialog).not.toContainText("GitHub");
});

async function openEditor(page: Page, theme: string, trigger: string, apps: Array<typeof hosted | typeof custom> = [hosted, custom]) {
  await openSetup(page, theme, "automations", apps);
  await page.getByRole("button", { name: "New automation", exact: true }).first().click();
  await page.getByRole("button", { name: /Start from scratch/ }).click();
  await page.getByRole("button", { name: "Add trigger" }).click();
  await page.getByRole("option", { name: new RegExp(`^${trigger}`) }).click();
}

test("GitHub trigger setup offers hosted and custom apps without losing the draft", async ({ page }, testInfo) => {
  await openEditor(page, "dark", "GitHub", []);
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Keep this draft");
  await page.getByRole("button", { name: "Set up or manage GitHub Apps" }).click();
  const setup = page.getByRole("dialog", { name: "GitHub App setup" });
  await expect(setup.getByRole("button", { name: "Install hosted Bivy App" })).toBeVisible();
  await expect(setup.getByText("Use your own GitHub App", { exact: true })).toBeVisible();
  await expect(setup).not.toContainText("Connections are managed only here");
  await page.screenshot({ path: testInfo.outputPath("hosted-first-setup.png") });
  await setup.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Keep this draft");
  await expect(page.getByRole("button", { name: "Turn on", exact: true })).toBeDisabled();
  await expect(page.getByText("Needs a name", { exact: false })).toHaveCount(0);
  await expect(page.getByText("a connected GitHub App", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Set up or manage GitHub Apps" }).click();
  await expect(setup).toBeVisible();
  await page.goBack();
  await expect(setup).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Keep this draft");
});

// Component fixtures below inject model/runtime events directly into the store.
// Picker mount still asks the controller for these lists; no daemon is running.
test.beforeEach(async ({ page }) => {
  for (const endpoint of ["runtimes", "models", "auth/providers", "auth/credentials", "auth/credential-assignments"]) {
    await page.route(new RegExp(`/api/${endpoint}(?:\\?|$)`), route => route.fulfill({
      status: 503, json: { error: "Lists supplied by the component fixture" },
    }));
  }
});

async function openSessionComposer(page: Page, theme: string) {
  const fixture = `/model-refresh-${theme}`;
  const html = await server.transformIndexHtml(fixture, `<html data-theme="${theme}"><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module">
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { Composer } from '/src/components/Composer.tsx';
    import { controller } from '/src/store/controller.ts';
    import '/@fs/${path.resolve("packages/ui/tokens.css")}';
    import '/src/styles.css';
    import '/src/ux-cleanup.css';
    const store = controller.store;
    window.commands = [];
    controller.send = (command) => {
      window.commands.push(command);
      if (command.kind === 'models.list' && command.sessionId === 'live') {
        const current = { id: 'gpt-5.4', label: 'GPT-5.4', provider: 'openai-codex' };
        store.apply({ type: 'models.list', sessionId: 'live', runtimeId: 'pi', current, models: [current] });
      }
    };
    // Deliver through the same reducer → model reconciliation order as the
    // controller's transport handler, without a real agent/network dependency.
    window.deliver = (event) => { store.apply(event); controller.maybeRefreshModelsForRuntime(event); };
    store.apply({ type: 'sessions.list', sessions: [{ sessionId: 'live', runtimeId: 'pi', status: 'live' }] });
    store.apply({ type: 'runtimes.list', runtimes: [{ id: 'pi', name: 'Pi' }], current: { id: 'pi', name: 'Pi' } });
    store.beginOpen('live');
    function App() {
      const state = React.useSyncExternalStore((listener) => store.subscribe(listener), () => store.getState());
      return React.createElement(Composer, { state, disabled: false, working: false, onSend: () => {}, onAbort: () => {} });
    }
    createRoot(document.getElementById('root')).render(React.createElement(App));
  </script></body></html>`);
  await page.route(`${origin}${fixture}`, (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto(`${origin}${fixture}`);
}

for (const theme of ["light", "dark"]) {
  test(`session model resolves without opening the picker (${theme})`, async ({ page }, testInfo) => {
    await openSessionComposer(page, theme);
    await expect(page.locator(".model-pill")).toBeVisible();
    await page.evaluate(() => {
      const fixture = window as unknown as { deliver: (event: unknown) => void };
      // A reconnect can list the node's fallback session, not the one on screen.
      fixture.deliver({ type: "models.list", sessionId: "other", models: [], current: null });
      fixture.deliver({ type: "session.history", sessionId: "live", runtimeId: "pi", messages: [] });
    });
    await expect(page.locator(".model-pill")).toHaveText("GPT-5.4");
    expect(await page.evaluate(() => (window as unknown as { commands: unknown[] }).commands)).toContainEqual({ kind: "models.list", sessionId: "live" });
    await page.screenshot({ path: testInfo.outputPath(`session-model-${theme}.png`) });
    await page.locator(".model-pill").click();
    await expect(page.getByRole("dialog", { name: "Model", exact: true })).toContainText("GPT-5.4");
    await expect(page.locator(".model-pill")).toHaveText("GPT-5.4");
    // Once known, repeated history updates need not re-fetch the model catalog.
    const count = await page.evaluate(() => (window as unknown as { commands: unknown[] }).commands.length);
    await page.evaluate(() => (window as unknown as { deliver: (event: unknown) => void }).deliver({ type: "session.history", sessionId: "live", runtimeId: "pi", messages: [] }));
    expect(await page.evaluate(() => (window as unknown as { commands: unknown[] }).commands.length)).toBe(count);
  });

  test(`automation trigger shows actual selected app handles and labels (${theme})`, async ({ page }, testInfo) => {
    await openEditor(page, theme, "GitHub");
    await expect(page.locator(".autom-trigger-config").getByText("Hosted + custom apps connected", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Manage GitHub Apps", exact: true })).toBeVisible();
    await expect(page.getByText("Choose the hosted Bivy App for the easiest setup", { exact: false })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Set up or manage GitHub Apps" })).toHaveCount(0);
    await expect(page.getByRole("checkbox", { name: /conversation containing @bivy-hosted or @acme-bot/ })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Who can trigger with a GitHub mention?" })).toBeVisible();
    await expect(page.getByLabel("Limit to these repositories (optional)")).toBeVisible();
    await expect(page.getByText("This filters events; it does not grant repository access.", { exact: false })).toBeVisible();
    await page.getByLabel("GitHub App source", { exact: true }).selectOption("456");
    await expect(page.getByRole("checkbox", { name: "Issue or PR conversation containing @acme-bot", exact: true })).toBeVisible();
    const labels = page.getByLabel("Trigger labels", { exact: true });
    await expect(labels).toHaveValue("bivy");
    await labels.fill("fix-it, ready for review");
    await expect(page.getByRole("checkbox", { name: "Issue labeled: fix-it, ready for review", exact: true })).toBeVisible();
    await labels.fill("");
    await expect(page.getByRole("checkbox", { name: "Issue labeled: bivy", exact: true })).toBeVisible();
    await labels.fill("fix-it, ready for review");
    await page.screenshot({ path: testInfo.outputPath(`github-trigger-${theme}.png`) });
  });

  test(`long automation prompt keeps the cursor in view while typing (${theme})`, async ({ page }, testInfo) => {
    // A short viewport models the space above a mobile keyboard. Playwright
    // cannot open a real iOS keyboard, but this reproduces the scroll clamp.
    await page.setViewportSize({ width: testInfo.project.name === "mobile" ? 390 : 1000, height: 440 });
    await openEditor(page, theme, "GitHub");
    const prompt = page.getByRole("textbox", { name: "Instructions", exact: true });
    await prompt.fill(Array.from({ length: 100 }, (_, i) => `Line ${i}`).join("\n"));
    const before = await prompt.evaluate((input: HTMLTextAreaElement) => {
      input.focus({ preventScroll: true });
      const caret = input.value.indexOf("Line 75") + "Line 75".length;
      input.setSelectionRange(caret, caret);
      const scroller = input.closest(".wizard-body")!;
      const style = getComputedStyle(input);
      const caretY = input.getBoundingClientRect().top + parseFloat(style.paddingTop) + 75 * parseFloat(style.lineHeight);
      scroller.scrollTop += caretY - scroller.getBoundingClientRect().top - scroller.clientHeight / 2;
      return scroller.scrollTop;
    });
    await prompt.pressSequentially(" typing", { delay: 50 });
    await expect(prompt).toBeFocused();
    const after = await prompt.evaluate((input) => input.closest(".wizard-body")!.scrollTop);
    expect(Math.abs(after - before)).toBeLessThan(30);
    await prompt.press("Enter");
    await prompt.pressSequentially("New line", { delay: 50 });
    await prompt.press("Backspace");
    const position = await prompt.evaluate((input: HTMLTextAreaElement) => {
      const style = getComputedStyle(input);
      const lines = input.value.slice(0, input.selectionStart).split("\n").length;
      const caretY = input.getBoundingClientRect().top + parseFloat(style.paddingTop) + lines * parseFloat(style.lineHeight);
      const scroller = input.closest(".wizard-body")!.getBoundingClientRect();
      return { caretY, top: scroller.top, bottom: scroller.bottom, height: input.clientHeight, contentHeight: input.scrollHeight };
    });
    expect(position.caretY).toBeGreaterThan(position.top);
    expect(position.caretY).toBeLessThan(position.bottom);
    expect(position.height).toBeGreaterThanOrEqual(position.contentHeight - 1);
    await page.screenshot({ path: testInfo.outputPath(`prompt-cursor-${theme}.png`) });
    // Deleting text must still shrink the editor instead of leaving a huge gap.
    await prompt.fill("Short prompt");
    expect(await prompt.evaluate((input) => input.clientHeight)).toBeLessThan(position.height);
  });

  test(`webhook editor allows custom header names and values (${theme})`, async ({ page }, testInfo) => {
    await openEditor(page, theme, "Webhook");
    await expect(page.getByLabel("Authentication method")).toHaveValue("hmac");
    await page.getByLabel("Custom signing secret (optional)").fill("my-provider-secret-with-at-least-32-characters");
    await page.getByLabel("Header name", { exact: true }).fill("X-Provider-Signature");
    await page.getByLabel("Authentication method").selectOption("header");
    await page.getByLabel("Header name", { exact: true }).fill("Authorization");
    await page.getByLabel("Custom header value (optional)").fill("Bearer a-user-selected-value-long-enough");
    await expect(page.getByLabel("Custom header value (optional)")).toHaveAttribute("type", "password");
    await expect(page.getByText("The sender puts the exact secret value", { exact: false })).toBeVisible();
    await page.getByLabel("Authentication method").evaluate((element) => element.closest(".autom-trigger-config")?.scrollIntoView({ block: "start" }));
    await page.screenshot({ path: testInfo.outputPath(`webhook-${theme}.png`) });
  });
}
