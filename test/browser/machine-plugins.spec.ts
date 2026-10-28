// SPDX-License-Identifier: MIT
//
// Settings → this machine → Plugins: what agents installed, and the two things
// a person does about it here. Removing asks first; choosing a theme applies it.
import { expect, test, type WebApp } from "./fixtures.js";
import { fileURLToPath } from "node:url";

let server: WebApp;
let origin: string;
test.beforeAll(async ({ webApp }) => {
  server = webApp;
  origin = webApp.origin;
});

test("plugins say what they add; removing asks first, and a theme can be chosen", async ({ page }) => {
  const capabilities = {
    generatedAt: new Date().toISOString(), os: { platform: "linux", arch: "x64", release: "6", type: "Linux" },
    agents: { maintained: [], custom: [] }, providers: { configured: [], localEndpoints: { count: 0, withModels: 0 } },
    docker: { state: "unknown" }, gpu: { state: "unknown" }, workspaces: { count: 1 }, theme: null,
    plugins: [
      { id: "review-checklist", name: "Review checklist", version: "0.1.0", valid: true, agentCount: 0, contributions: { widgets: 1, tools: 1, guides: 1, themes: [] } },
      { id: "dusk", name: "Dusk", version: "1.0.0", valid: true, agentCount: 0, contributions: { widgets: 0, tools: 0, guides: 0, themes: [{ id: "dusk", name: "Dusk" }] } },
    ],
  };
  const html = await server.transformIndexHtml("/plugins-test", `<!doctype html><html><head></head><body><div id="root"></div><script type="module">
    import { createElement as h } from 'react';
    import { createRoot } from 'react-dom/client';
    import '/@fs/${fileURLToPath(new URL("../../packages/ui/tokens.css", import.meta.url))}';
    import '/src/styles.css';
    import { MachineCapabilitiesSection } from '/src/components/MachineCapabilities.tsx';
    import { controller } from '/src/store/useStore.ts';
    window.commands = [];
    controller.requestCapabilities = () => {};
    controller.pluginCommand = async (kind, fields) => { window.commands.push([kind, fields.id]); return {}; };
    controller.store.apply({ type: 'capabilities', capabilities: ${JSON.stringify(capabilities)} });
    createRoot(document.getElementById('root')).render(h(MachineCapabilitiesSection, { online: true }));
    </script></body></html>`);
  await page.route(`${origin}/plugins-test`, (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto(`${origin}/plugins-test`);
  const commands = () => page.evaluate(() => (window as unknown as { commands: unknown[] }).commands);

  await expect(page.getByText("1 widget · 1 tool · 1 guide")).toBeVisible();
  await expect(page.getByText("theme Dusk")).toBeVisible();

  await page.getByRole("button", { name: "Remove Review checklist" }).click();
  expect(await commands()).toEqual([]);
  await page.getByRole("button", { name: "Keep" }).click();
  await page.getByRole("button", { name: "Remove Review checklist" }).click();
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await expect.poll(commands).toEqual([["plugins.remove", "review-checklist"]]);

  await page.getByLabel("Theme").selectOption("dusk");
  await expect.poll(commands).toEqual([["plugins.remove", "review-checklist"], ["plugins.theme", "dusk"]]);
});
