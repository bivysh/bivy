// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "../../packages/web/node_modules/vite/dist/node/index.js";
import { githubSourceStatus, githubMentionHandles, githubInstallationSettings } from "../../packages/web/src/components/githubSource.js";

const installation = { installationId: "42", githubAccount: "acme", githubAccountType: "Organization", createdAt: "2026-09-01" };
const hosted = { connected: true, appId: "123", central: true, hosted: true, installed: true, mention: "bivy-hosted", name: "Hosted Bivy App", servedBy: null, installations: [installation] };
const custom = { connected: true, appId: "456", installed: true, mention: "acme-bot", name: "Acme custom app", servedBy: null };
let server: ViteDevServer;
let origin: string;

test.beforeAll(async () => {
  server = await createServer({ root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../packages/web"), logLevel: "silent", server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  const address = server.httpServer!.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await server?.close(); });

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

async function openSetup(page: Page, theme: string, focus = "github", apps: Array<typeof hosted | typeof custom> = [hosted], fail = false) {
  await page.route("**/account/**", (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const json = pathname === "/account/github-app" ? { connected: apps.length > 0, apps }
      : ["/account/automations", "/account/automation-runs"].includes(pathname) ? []
      : { enabled: false, execution: { ready: false } };
    return route.fulfill({ json });
  });
  await page.route("**/nodes", (route) => route.fulfill({ json: [] }));
  const fixturePath = `/source-test-${theme}-${focus}-${apps.length}-${fail}`;
  const html = await server.transformIndexHtml(fixturePath, `<html data-theme="${theme}"><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module">
    import React from '/node_modules/.vite/deps/react.js';
    import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
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
    controller.centralGithubApp = async () => ({ configured: true, installations: [] });
    const state = controller.store.getState();
    ReactDOM.createRoot(document.getElementById('root')).render(${focus === "automations"
      ? `React.createElement(AutomationsView, { state, section: null, onSectionChange: () => {}, onOpenSession: () => {}, onClose: () => {} })`
      : `React.createElement(WorkQueueSetupSheet, { state, focus: ${JSON.stringify(focus)}, onClose: () => document.getElementById('root').textContent = 'Closed' })`});
  </script></body></html>`);
  await page.route(`${origin}${fixturePath}`, (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto(`${origin}${fixturePath}`);
}

for (const theme of ["light", "dark"]) {
  test(`hosted GitHub setup is separate, actionable, and explicit (${theme})`, async ({ page }, testInfo) => {
    await openSetup(page, theme);
    const dialog = page.getByRole("dialog", { name: "GitHub App setup" });
    await expect(dialog.getByText("Connected", { exact: true })).toBeVisible();
    await expect(dialog).not.toContainText("Linear");
    await expect(dialog).not.toContainText("Work issues into PRs");
    await expect(dialog).not.toContainText("No GitHub App yet");
    await expect(dialog).toContainText("@bivy-hosted");
    await expect(dialog).toContainText("Default label trigger: bivy");
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

for (const theme of ["light", "dark"]) {
  test(`automation trigger shows actual selected app handles and labels (${theme})`, async ({ page }, testInfo) => {
    await openEditor(page, theme, "GitHub");
    await expect(page.getByRole("checkbox", { name: /conversation containing @bivy-hosted or @acme-bot/ })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Who can trigger with a GitHub mention?" })).toBeVisible();
    await expect(page.getByLabel("Limit to these repositories (optional)")).toBeVisible();
    await expect(page.getByText("This filters events; it does not grant repository access.", { exact: false })).toBeVisible();
    await page.getByLabel("GitHub App source", { exact: true }).selectOption("456");
    await expect(page.getByRole("checkbox", { name: "Issue or PR conversation containing @acme-bot", exact: true })).toBeVisible();
    await page.getByLabel("Labels", { exact: true }).fill("fix-it, ship-it");
    await expect(page.getByRole("checkbox", { name: "Issue labeled: fix-it, ship-it", exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`github-trigger-${theme}.png`) });
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
