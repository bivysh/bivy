// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from "./fixtures.js";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type ViteDevServer } from "../../packages/web/node_modules/vite/dist/node/index.js";
import { seal, open } from "../../src/e2e.js";
import { encodeAutomationTemplate, decodeAutomationTemplate } from "../../src/automation-template.js";

let server: ViteDevServer;
let origin: string;
let cacheDir: string;
const key = Buffer.alloc(32, 7);
const instructions = "Review incoming work and run the relevant tests.";

test.beforeAll(async () => {
  const root = path.resolve("packages/web");
  cacheDir = await mkdtemp(path.join(root, "node_modules/.vite-automation-accounts-"));
  server = await createServer({ root, cacheDir, logLevel: "silent", server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  const address = server.httpServer!.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await server?.close(); if (cacheDir) await rm(cacheDir, { recursive: true, force: true }); });

async function fixture(page: Page, theme: string, empty = false, trigger = "schedule") {
  let item = {
    id: "automation-test", name: "Daily review", trigger, enabled: true,
    repo: "acme/app", nodeLabel: "bivy/Runner", runtimeId: "pi", model: "claude-sonnet",
    schedule: { kind: "cron", expression: "0 9 * * 1-5", timezone: "UTC" },
    templateCiphertext: `bivy-room-v1:runner:${seal(key, encodeAutomationTemplate(instructions, { anthropic: "work", "openai-codex": "retired" }))}`,
  };
  const nodes = [{ id: "runner", name: "Runner", online: true }];
  for (const endpoint of ["runtimes", "models", "repos"]) {
    await page.route(new RegExp(`/api/${endpoint}(?:\\?|$)`), (route) => route.fulfill({ status: 503, json: { error: "Catalog supplied by fixture" } }));
  }
  await page.route("**/account/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/account/automations/automation-test" && route.request().method() === "PUT") {
      item = { ...item, ...route.request().postDataJSON() };
      return route.fulfill({ json: item });
    }
    const json = url.pathname.endsWith("/simulate")
      ? { preflight: [], gate: { blocked: false, blockingChecks: [], requiresAck: false, warnChecks: [] }, match: { matched: true }, routing: {} }
      : url.pathname === "/account/automations" ? [item]
      : url.pathname === "/account/nodes" ? nodes
      : url.pathname === "/account/automation-runs" ? [] : { connected: false, enabled: false };
    return route.fulfill({ json });
  });
  await page.route("**/nodes", (route) => route.fulfill({ json: nodes }));
  const fixturePath = `/automation-accounts-fixture-${theme}-${empty}-${trigger}`;
  const html = await server.transformIndexHtml(fixturePath, `<html data-theme="${theme}"><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module">
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { AutomationsView } from '/src/components/AutomationsView.tsx';
    import { controller } from '/src/store/controller.ts';
    import '/@fs/${path.resolve("packages/ui/tokens.css")}';
    import '/src/styles.css';
    import '/src/ux-cleanup.css';
    controller.direct = false;
    controller.local.s = 'test';
    controller.local.cp = ${JSON.stringify(origin)};
    controller.local.cur = 'runner';
    controller.local.addKey('runner', ${JSON.stringify(key.toString("base64url"))});
    controller.fetchMe = async () => null;
    controller.listCredentialRecords = () => {};
    const state = controller.store.getState();
    state.connection.currentNodeId = 'runner';
    state.connection.nodes = ${JSON.stringify(nodes)};
    state.catalogs.providers = [{id: 'anthropic', name: 'Anthropic'}, {id: 'openai-codex', name: 'OpenAI — ChatGPT subscription'}];
    state.catalogs.runtimes = [{id: 'pi', displayName: 'Pi'}];
    state.catalogs.models = [{id: 'claude-sonnet', label: 'Claude Sonnet', provider: 'anthropic'}];
    state.settings.credentialRecords = ${JSON.stringify(empty ? [] : [
      { provider: "anthropic", label: "default", kind: "oauth" },
      { provider: "anthropic", label: "work", kind: "oauth" },
      { provider: "openai-codex", label: "default", kind: "oauth" },
      { provider: "openai-codex", label: "work — engineering and platform team", kind: "oauth" },
    ])};
    createRoot(document.getElementById('root')).render(React.createElement(AutomationsView, {state, section: null, onSectionChange: () => {}, onOpenSession: () => {}, onClose: () => {}}));
  </script></body></html>`);
  await page.route(`${origin}${fixturePath}`, (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto(`${origin}${fixturePath}`);
  await page.getByRole("button", { name: "Edit Daily review" }).click();
  return () => item;
}

for (const theme of ["light", "dark"]) {
  test(`automation accounts round-trip without changing instructions (${theme})`, async ({ page }, testInfo) => {
    const item = await fixture(page, theme);
    const anthropic = page.getByLabel("Anthropic account", { exact: true });
    const openai = page.getByLabel("OpenAI — ChatGPT subscription account", { exact: true });
    await expect(anthropic).toHaveValue("work");
    await expect(openai).toHaveValue("retired");
    await expect(openai.locator("option:checked")).toHaveText("retired (unavailable here)");
    await anthropic.focus();
    await expect(anthropic).toBeFocused();
    await anthropic.selectOption("default");
    await openai.selectOption("work — engineering and platform team");
    await anthropic.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`automation-accounts-${theme}.png`) });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    expect(overflow).toBe(false);
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Edit automation" })).toHaveCount(0);
    const decode = () => decodeAutomationTemplate(open(key, item().templateCiphertext.split(":").slice(2).join(":")));
    expect(decode()).toEqual({ instructions, credentialLabels: { anthropic: "default", "openai-codex": "work — engineering and platform team" } });
    await page.reload();
    await page.getByRole("button", { name: "Edit Daily review" }).click();
    await expect(anthropic).toHaveValue("default");
    await anthropic.selectOption("");
    await openai.selectOption("");
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Edit automation" })).toHaveCount(0);
    expect(decode()).toEqual({ instructions, credentialLabels: {} });
  });
}

test("legacy CI editor preserves instructions when changing accounts", async ({ page }) => {
  const item = await fixture(page, "light", false, "github_ci");
  await page.getByText("Agent & model defaults", { exact: true }).click();
  const account = page.getByLabel("Anthropic account", { exact: true });
  await expect(account).toHaveValue("work");
  await account.selectOption("default");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => decodeAutomationTemplate(open(key, item().templateCiphertext.split(":").slice(2).join(":")))).toEqual({
    instructions, credentialLabels: { anthropic: "default", "openai-codex": "retired" },
  });
});

test("unavailable accounts remain visible and can be cleared", async ({ page }) => {
  await fixture(page, "light", true);
  const account = page.getByLabel("Anthropic account", { exact: true });
  await expect(account).toHaveValue("work");
  await expect(account.locator("option:checked")).toHaveText("work (unavailable here)");
  await account.selectOption("");
  await page.getByLabel("OpenAI — ChatGPT subscription account", { exact: true }).selectOption("");
  await expect(page.getByRole("status").filter({ hasText: "No accounts loaded" })).toBeVisible();
});
