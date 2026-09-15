// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "./fixtures.js";
import { createServer, type ViteDevServer } from "../../packages/web/node_modules/vite/dist/node/index.js";
import path from "node:path";
import { webRuntimeConfigScript } from "../../services/control-plane/src/web-runtime-config.js";

let server: ViteDevServer;
let origin: string;
test.beforeAll(async () => {
  server = await createServer({ root: path.resolve("packages/web"), logLevel: "error", server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  origin = new URL(server.resolvedUrls!.local[0]).origin;
});
test.afterAll(async () => { await server?.close(); });

for (const theme of ["light", "dark"]) {
  test(`deployment flags load before app modules and change on reload (${theme})`, async ({ page }) => {
    await page.addInitScript(theme => localStorage.setItem("bivy_theme", theme), theme);
    // This test exercises startup configuration, not a connected node.
    for (const endpoint of ["auth/bootstrap", "auth/credentials/account-export", "sessions", "models*", "runtimes", "stt/config"]) {
      await page.route(`**/api/${endpoint}`, route => route.fulfill({ status: 503, json: { error: "Node unavailable in runtime-config fixture" } }));
    }
    let enabled = "1";
    let requests = 0;
    await page.route("**/runtime-config.js", async route => {
      requests++;
      await route.fulfill({ contentType: "application/javascript", headers: { "Cache-Control": "no-store" }, body: webRuntimeConfigScript({ EPHEMERAL_MACHINES_ENABLED: enabled }) });
    });
    const flag = () => page.evaluate(async () => {
      const modulePath = "/src/flags.ts";
      return (await import(modulePath)).EPHEMERAL_MACHINES_ENABLED as boolean;
    });
    await page.goto(origin);
    expect(await flag()).toBe(true);
    enabled = "0";
    await page.reload();
    expect(await flag()).toBe(false);
    enabled = "1";
    await page.reload();
    expect(await flag()).toBe(true);
    expect(requests).toBe(3);
    await expect(page.locator("#root")).not.toBeEmpty();
  });
}
