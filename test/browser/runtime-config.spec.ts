// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type WebApp } from "./fixtures.js";
import { webRuntimeConfigScript } from "../../services/control-plane/src/web-runtime-config.js";

let server: WebApp;
let origin: string;
test.beforeAll(async ({ webApp }) => {
  server = webApp;
  origin = webApp.origin;
});

// Startup script ordering and reload caching do not depend on color theme.
test("deployment flags load before app modules and change on reload", async ({ page }) => {
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
