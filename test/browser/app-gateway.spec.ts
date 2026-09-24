// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "./fixtures.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { AppRegistry } from "../../src/apps/registry.js";
import { AppGateway } from "../../src/apps/gateway.js";

// The browser sees real HTTPS preview origins. This fixture acts only as the
// TLS reverse proxy, forwarding each request to the real loopback gateway.
// No launch, cookie, static-content or revocation behavior is mocked.
test("preview launch redeems its fragment, runs JavaScript, isolates cookies and revokes access", async ({ page, context }, testInfo) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bivy-preview-browser-"));
  const registry = new AppRegistry();
  const gateway = new AppGateway(registry, "https://{app}.preview.example.net", () => ["https://bivy.example"]);
  gateway.server.listen(0, "127.0.0.1");
  await once(gateway.server, "listening");
  const port = (gateway.server.address() as { port: number }).port;
  try {
    await fs.writeFile(path.join(dir, "index.html"), '<!doctype html><html lang="en"><title>Generated app</title><button id="increment">Increment</button><output id="count">0</output><script src="/app.js"></script></html>');
    await fs.writeFile(path.join(dir, "app.js"), 'let n=0;document.getElementById("increment").onclick=()=>document.getElementById("count").textContent=String(++n);');
    const app = registry.publish("s", dir, { version: 1, name: "Counter", views: [{ kind: "web", name: "Counter", source: { kind: "static", directory: "." } }] });
    const id = app.views[0].id;
    await page.route("https://*.preview.example.net/**", async (route) => {
      const request = route.request(); const url = new URL(request.url());
      const response = await route.fetch({ url: `http://127.0.0.1:${port}${url.pathname}${url.search}`, headers: { ...await request.allHeaders(), host: url.host }, maxRedirects: 0 });
      await route.fulfill({ response });
    });
    const returnTo = 'https://bivy.example/sessions/s';
    await page.route(returnTo, (route) => route.fulfill({ contentType: "text/html", body: "<h1>Bivy chat</h1>" }));
    await page.goto(gateway.open(id, returnTo));
    await expect(page).toHaveURL(`${gateway.shellOrigin(id)}/__bivy/open`);
    const content = page.frameLocator('iframe[title="Counter"]');
    await content.getByRole("button", { name: "Increment" }).click();
    await expect(content.locator("output")).toHaveText("1");
    expect(await content.locator("body").evaluate(() => document.cookie)).not.toContain("bivy-preview");
    expect(await content.locator("body").evaluate(() => { try { parent.document.querySelector('nav')?.remove(); return true; } catch { return false; } })).toBe(false);
    await expect(page.getByRole("navigation", { name: "Bivy preview controls" })).toBeVisible();
    await page.getByRole("button", { name: "Reload", exact: true }).click();
    await expect(content.locator("output")).toHaveText("0");
    await page.screenshot({ path: testInfo.outputPath("open-app-with-header.png"), fullPage: true });
    const light = await page.getByRole("navigation").evaluate((element) => getComputedStyle(element).backgroundColor);
    await page.emulateMedia({ colorScheme: "dark" });
    await expect.poll(() => page.getByRole("navigation").evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(light);
    await page.getByRole("button", { name: "Back to chat" }).focus();
    await expect(page.getByRole("button", { name: "Back to chat" })).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath("open-app-with-header-dark.png"), fullPage: true });
    const cookies = await context.cookies(gateway.origin(id));
    const credential = cookies.find((cookie) => cookie.name === "__Host-bivy-preview");
    expect(credential?.httpOnly).toBe(true);
    expect(credential?.secure).toBe(true);
    expect(credential?.domain).toBe(new URL(gateway.origin(id)).hostname);
    gateway.revoke(id);
    await page.reload();
    await expect(content.getByText("Preview access expired. Open a new preview link from Bivy.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Back to chat" })).toBeVisible();
    // Exercise fallback navigation for browser contexts that refuse close().
    await page.evaluate(() => { window.close = () => {}; });
    await page.getByRole("button", { name: "Back to chat" }).click();
    await expect(page).toHaveURL(returnTo);
  } finally { gateway.close(); await fs.rm(dir, { recursive: true, force: true }); }
});
