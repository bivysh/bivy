// SPDX-License-Identifier: AGPL-3.0-only
// Actions with real consequences (unsandboxed access, billable machines, a
// stopped agent) need an informed, explicit step in the real components. Each
// test renders the component with a stubbed controller and records its calls.
import { expect, test, type WebApp } from "./fixtures.js";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";

let server: WebApp;
let origin: string;

test.beforeAll(async ({ webApp }) => {
  server = webApp;
  origin = webApp.origin;
});

/** Render `script` (a module body that sets up `h`, `root` and `calls`) as a page. */
async function render(page: Page, name: string, script: string) {
  const html = await server.transformIndexHtml(`/${name}`, `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div>
    <script type="module">
      import { createElement as h } from 'react';
      import { createRoot } from 'react-dom/client';
      import '/@fs/${fileURLToPath(new URL("../../packages/ui/tokens.css", import.meta.url))}';
      import '/src/styles.css';
      const { controller } = await import('/src/store/useStore.ts');
      window.calls = [];
      const root = createRoot(document.getElementById('root'));
      ${script}
    </script></body></html>`);
  await page.route(`${origin}/${name}`, (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto(`${origin}/${name}`);
}
const calls = (page: Page) => page.evaluate(() => (window as unknown as { calls: unknown[] }).calls);

test("full computer access needs a second, informed selection", async ({ page }) => {
  await render(page, "sandbox-picker", `
    const { SandboxPicker } = await import('/src/components/Pickers.tsx');
    controller.setSessionSandbox = (id) => window.calls.push(id);
    const state = { settings: { nodeSettings: {} }, catalogs: { runtimes: [], selectedAgentId: null, currentAgentName: "Claude" }, draft: { sandbox: null } };
    root.render(h(SandboxPicker, { state, onClose: () => window.calls.push("closed") }));
  `);
  await page.getByText("Full access", { exact: true }).click();
  await expect(page.getByText("Confirm full computer access")).toBeVisible();
  await expect(page.getByText(/Bivy is not an isolation boundary/)).toBeVisible();
  expect(await calls(page)).toEqual([]);
  await page.getByText("Confirm full computer access").click();
  expect(await calls(page)).toEqual(["danger-full-access", "closed"]);
});

test("Stop shows progress at once and offers recovery when the agent never confirms", async ({ page }) => {
  await page.clock.install();
  // The composer probes voice input on mount; it is not part of this flow.
  await page.route("**/api/stt/config", (route) => route.fulfill({ json: { enabled: false } }));
  await render(page, "composer-stop", `
    const { Composer } = await import('/src/components/Composer.tsx');
    const state = controller.store.getState();
    root.render(h(Composer, { state, disabled: false, working: true, onSend: () => {}, onAbort: () => window.calls.push("abort") }));
  `);
  const stop = page.getByRole("button", { name: "Stop current turn" });
  await stop.click();
  const stopping = page.getByRole("button", { name: "Stopping current turn" });
  await expect(stopping).toBeDisabled();
  await expect(stopping).toContainText("Stopping…");
  expect(await calls(page)).toEqual(["abort"]);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.clock.runFor(10_000);
  await expect(page.getByRole("alert")).toContainText("The agent didn't confirm it stopped.");
  await expect(page.getByRole("button", { name: "Reload" })).toBeVisible();
});

test("a billable machine profile is chosen only after its cost and teardown are shown", async ({ page }) => {
  await render(page, "billable-runner", `
    const { EphemeralSheet } = await import('/src/components/Ephemeral.tsx');
    const { ephemeralAdapter } = await import('@bivy/core');
    const size = ephemeralAdapter('fly').sizes[0];
    Object.assign(controller, {
      listEphemeralKeys: async () => [],
      getEphemeralToken: async () => null,
      getDeviceVaultSyncState: () => ({ phase: 'idle', attemptedAt: null, succeededAt: null, pending: false, failure: null }),
      connectEphemeralProvider: async (provider) => ({ id: 'runner-1', provider, size: size.id, region: 'ams', ttlMinutes: 60, teardownOnAgentFinish: true }),
      defaultEphemeralRunner: async (provider) => ({ id: 'runner-1', provider, size: size.id, region: 'ams', ttlMinutes: 60, teardownOnAgentFinish: true }),
      pickDraftEphemeralRunner: (runner) => window.calls.push(['pick', runner.id]),
    });
    root.render(h(EphemeralSheet, { onClose: () => window.calls.push('closed') }));
  `);
  await page.getByText("Fly.io · Recommended").click();
  await page.getByPlaceholder("Paste token").fill("fly-token");
  await page.getByRole("button", { name: "Connect", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: "Use this billable machine profile?" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("in ams");
  await expect(dialog).toContainText("It will be destroyed when the agent finishes; the TTL remains a backstop.");
  expect(await calls(page)).toEqual([]);

  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect(await calls(page)).toEqual([], "cancelling never selects the billable profile");
  // The provider is now connected; choosing its profile asks again.
  await page.getByRole("button", { name: "Use this profile" }).click();
  await page.getByRole("dialog", { name: "Use this billable machine profile?" }).getByRole("button", { name: "Use profile" }).click();
  expect(await calls(page)).toEqual([["pick", "runner-1"], "closed"]);
});

test("a new approval is announced and takes keyboard focus in the real app", async ({ page }) => {
  await page.route("**/api/**", (route) => route.fulfill({ json: {} }));
  // Drive the real App from store events; keep it off the network.
  await page.route("**/src/mount.tsx", async (route) => {
    const response = await route.fetch();
    const source = (await response.text()).replace("controller.connect();", "").replace("controller.installLifecycleHandlers();", "");
    await route.fulfill({ response, body: source });
  });
  await page.goto(origin);
  await page.evaluate(async () => {
    const modulePath = "/src/store/useStore.ts";
    const { controller } = await import(modulePath);
    controller.store.setCurrentNode("node-a");
    controller.store.setNodes([{ id: "node-a", name: "Test machine", online: true }]);
    controller.store.set({ sessions: [{ sessionId: "s1", name: "Build fix", nodeId: "node-a", status: "working" }] });
    controller.store.beginOpen("s1");
  });
  await page.evaluate(async () => {
    const modulePath = "/src/store/useStore.ts";
    const { controller } = await import(modulePath);
    controller.store.apply({ type: "approval.created", approval: { id: "a1", sessionId: "s1", tool: "bash", summary: "rm -rf build" } });
  });
  const card = page.locator("[data-attention-card]");
  await expect(card).toBeFocused();
  await expect(page.locator('[aria-live="polite"]').filter({ has: card })).toHaveCount(1);
});

test("a source Automation template opens a draft for review; nothing goes live until saved", async ({ page }) => {
  const writes: string[] = [];
  await page.route("**/account/**", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== "GET") writes.push(`${request.method()} ${url.pathname}`);
    const json = url.pathname === "/account/automations" ? []
      : url.pathname === "/account/nodes" ? [{ id: "runner", name: "Runner", online: true }]
      : url.pathname === "/account/automation-runs" ? []
      : { connected: false, enabled: false };
    return route.fulfill({ json });
  });
  await page.route("**/nodes", (route) => route.fulfill({ json: [{ id: "runner", name: "Runner", online: true }] }));
  for (const endpoint of ["runtimes", "models", "repos"]) {
    await page.route(new RegExp(`/api/${endpoint}(?:\\?|$)`), (route) => route.fulfill({ status: 503, json: { error: "not needed" } }));
  }
  await render(page, "automation-template", `
    const { AutomationsView } = await import('/src/components/AutomationsView.tsx');
    Object.assign(controller, { direct: false, fetchMe: async () => null, listCredentialRecords: () => {} });
    Object.assign(controller.local, { s: 'test', cp: location.origin, cur: 'runner' });
    const state = controller.store.getState();
    state.connection.currentNodeId = 'runner';
    state.connection.nodes = [{ id: 'runner', name: 'Runner', online: true }];
    root.render(h(AutomationsView, { state, section: null, onSectionChange: () => {}, onOpenSession: () => {}, onOpenRun: () => {} }));
  `);
  await page.getByRole("button", { name: "New automation" }).first().click();
  await page.getByText("Fix failed CI", { exact: true }).first().click();
  await expect(page.getByRole("textbox", { name: /name/i }).first()).toHaveValue("Fix failed CI");
  expect(writes, "choosing a template must not create or update an automation").toEqual([]);
});
