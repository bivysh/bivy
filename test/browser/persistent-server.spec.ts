// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "./fixtures.js";
import { createServer, type ViteDevServer } from "../../packages/web/node_modules/vite/dist/node/index.js";
import path from "node:path";

let server: ViteDevServer;
let origin: string;
test.beforeAll(async () => {
  server = await createServer({ root: path.resolve("packages/web"), logLevel: "error", server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  origin = new URL(server.resolvedUrls!.local[0]).origin;
});
test.afterAll(async () => { await server?.close(); });

for (const theme of ["light", "dark"]) {
  for (const outcome of ["success", "failure", "empty", "credential-error", "connect-error"]) {
    test(`persistent BYO ${outcome} (${theme})`, async ({ page }, info) => {
      page.on("pageerror", error => console.error(error.message));
      const url = `/persistent-${theme}-${outcome}`;
      const html = await server.transformIndexHtml(url, `<html data-theme="${theme}"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div>
        <script>globalThis.__BIVY_RUNTIME_CONFIG__ = { ephemeralMachinesEnabled: true };</script>
        <script type="module">
          import React from 'react'; import { createRoot } from 'react-dom/client';
          import { controller } from '/src/store/useStore.ts';
          import { AddNodeSheet } from '/src/components/AddNodeSheet.tsx';
          import '/@fs/${path.resolve("packages/ui/tokens.css")}'; import '/src/styles.css';
          globalThis.created = []; globalThis.dismissCount = 0; globalThis.connections = [];
          controller.getEphemeralToken = async () => '';
          controller.saveCloudProviderToken = async () => { if (${JSON.stringify(outcome)} === 'credential-error') throw new Error('Invalid provider token'); };
          controller.listEphemeralSizes = async () => ${outcome === "empty" ? "[]" : `[
            { id: 'budget', label: 'Budget · 2 vCPU · 4 GB · 80 GB (x86)', vcpus: 2, memoryMiB: 4096, architecture: 'x86_64', pricePerHour: 0.01 },
            { id: 'standard', label: 'Standard · 4 vCPU · 8 GB · 160 GB (x86)', vcpus: 4, memoryMiB: 8192, architecture: 'x86_64', pricePerHour: 0.02 },
            { id: 'arm', label: 'ARM', vcpus: 4, memoryMiB: 8192, architecture: 'arm64' }
          ]`};
          controller.launchEphemeral = async opts => {
            globalThis.created.push(opts);
            opts.onProgress('Creating your server…');
            await new Promise(resolve => setTimeout(resolve, 150));
            if (${JSON.stringify(outcome)} === 'failure') throw new Error('Provider request timed out');
            return { id: '42', nodeId: 'server-persistent', lifecycle: 'persistent' };
          };
          controller.connectToNode = async id => {
            globalThis.connections.push(id);
            if (${JSON.stringify(outcome)} === 'connect-error') throw new Error('Still installing');
          };
          createRoot(document.getElementById('root')).render(React.createElement(AddNodeSheet, { initialMode: 'server', onClose: () => { globalThis.dismissCount++; } }));
        </script></body></html>`);
      await page.route(`${origin}${url}`, route => route.fulfill({ contentType: "text/html", body: html }));
      await page.goto(`${origin}${url}`);
      await expect(page.getByRole("button", { name: "Connect provider", exact: true })).toBeDisabled();
      await page.getByLabel("Hetzner Cloud API token").fill("provider-secret");
      await page.getByRole("button", { name: "Connect provider", exact: true }).click();
      if (outcome === "credential-error") {
        await expect(page.getByRole("alert")).toContainText("Invalid provider token");
        expect(await page.evaluate(() => (globalThis as any).created)).toEqual([]);
        return;
      }
      if (outcome === "empty") {
        await expect(page.getByRole("button", { name: "Review server cost" })).toBeDisabled();
        await expect(page.getByRole("button", { name: "Retry sizes" })).toBeVisible();
        return;
      }
      await expect(page.getByLabel("Server size")).toHaveValue("standard");
      await expect(page.getByLabel("Server size").locator("option")).toHaveCount(2);
      await page.getByLabel("Server name").fill("A very long personal development server name for repositories and tools");
      await page.screenshot({ path: info.outputPath(`persistent-form-${theme}.png`), fullPage: true });
      // Keyboard activation reaches the explicit purchase confirmation.
      await page.getByRole("button", { name: "Review server cost" }).focus();
      await expect(page.getByRole("button", { name: "Review server cost" })).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("dialog").last()).toContainText("remains billable until you explicitly delete it");
      expect(await page.evaluate(() => (globalThis as any).created)).toEqual([]);
      await page.screenshot({ path: info.outputPath(`persistent-confirm-${theme}.png`), fullPage: true });
      await page.getByRole("button", { name: "Create billable server", exact: true }).click();
      if (outcome === "failure") {
        await expect(page.getByRole("alert")).toContainText("Check your provider console before trying again");
        await expect(page.getByRole("button", { name: "Review server cost" })).toHaveCount(0);
      } else {
        await expect(page.getByRole("status")).toContainText("Server created");
        await page.getByRole("button", { name: "Connect to server", exact: true }).click();
        if (outcome === "connect-error") {
          await expect(page.getByRole("alert")).toContainText("No replacement server was created");
          await page.getByRole("button", { name: "Connect to server", exact: true }).click();
        } else {
          await expect.poll(() => page.evaluate(() => (globalThis as any).dismissCount)).toBe(1);
        }
      }
      const launches = await page.evaluate(() => (globalThis as any).created);
      expect(launches).toHaveLength(1);
      expect(launches[0]).toMatchObject({ provider: "hetzner", lifecycle: "persistent", size: "standard", repo: "", githubToken: "" });
      expect(launches[0]).not.toHaveProperty("ttlMinutes");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`persistent-${outcome}-${theme}.png`), fullPage: true });
    });
  }
}
