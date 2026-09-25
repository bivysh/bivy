// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "./fixtures.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { AppRegistry } from "../../src/apps/registry.js";
import { AppGateway } from "../../src/apps/gateway.js";
import http from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { RemotePreview } from "../../src/apps/remote-preview.js";
import { PreviewRelay } from "../../services/relay/src/preview.js";

async function delivery(registry: AppRegistry, automatic: boolean) {
  if (!automatic) {
    const gateway = new AppGateway(registry, "https://{app}.preview.example.net", () => ["https://bivy.example"]);
    gateway.server.listen(0, "127.0.0.1"); await once(gateway.server, "listening");
    return { gateway, port: (gateway.server.address() as { port: number }).port, close: () => gateway.close() };
  }
  const relay = new PreviewRelay("https://{app}.preview.example.net");
  const remote = new RemotePreview(registry, () => ["https://bivy.example"]);
  const wss = new WebSocketServer({ noServer: true });
  const server = http.createServer((req, res) => { if (!relay.handle(req, res)) { res.writeHead(404); res.end(); } });
  server.on("upgrade", (req, socket, head) => {
    if (relay.upgrade(req, socket, head) || relay.upgradeStream(req, socket, head)) return;
    // Represents an already-admitted node. Actual admission and connector
    // discovery are exercised by test/relay-preview.test.ts.
    wss.handleUpgrade(req, socket, head, (ws) => ws.send(JSON.stringify({ t: "ready", origin: relay.attach(ws, "browser-node") })));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  let template = "";
  const control = new WebSocket(`ws://127.0.0.1:${port}/node`);
  await new Promise<void>((resolve, reject) => {
    control.on("error", reject);
    control.on("message", (bytes) => {
      const message = JSON.parse(bytes.toString());
      if (message.t === "ready") { template = message.origin; remote.ready(template, `ws://127.0.0.1:${port}`); resolve(); }
      if (message.t === "preview.connect") remote.connect(message.ticket);
    });
  });
  return {
    gateway: {
      open: (id: string, returnTo: string) => remote.open(id, returnTo),
      origin: (id: string) => template.replace("{app}", id),
      shellOrigin: (id: string) => template.replace("{app}", `view-${id}`),
      revoke: (id: string) => remote.revoke(id),
    }, port,
    close: () => { remote.close(); control.terminate(); relay.close(); for (const ws of wss.clients) ws.terminate(); wss.close(); server.close(); server.closeAllConnections(); },
  };
}

// The browser sees real HTTPS preview origins. This fixture acts only as the
// TLS reverse proxy, forwarding requests through direct or automatic delivery.
// No launch, cookie, static-content or revocation behavior is mocked.
for (const mode of ["direct", "automatic"]) test(`preview launch redeems its fragment, runs JavaScript, isolates cookies and revokes access (${mode})`, async ({ page, context }, testInfo) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bivy-preview-browser-"));
  const registry = new AppRegistry();
  const fixture = await delivery(registry, mode === "automatic");
  const { gateway, port } = fixture;
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
  } finally { fixture.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

// A stopped dev server is a state with a next step, not a blank frame: the
// shell says which port is silent, the frame recovers by itself when the
// server returns, and "Ask agent to fix" lands as a draft in that session.
test("a silent service shows a recoverable state and drafts a fix request", async ({ page }, testInfo) => {
  const registry = new AppRegistry();
  const fixture = await delivery(registry, false);
  const { gateway, port } = fixture;
  const probe = http.createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const deadPort = (probe.address() as { port: number }).port; await new Promise<void>((resolve) => probe.close(() => resolve()));
  let server: http.Server | undefined;
  try {
    const app = registry.publish("s", os.tmpdir(), { version: 1, name: "Ledger", views: [{ kind: "web", name: "Ledger", source: { kind: "service", port: deadPort } }] });
    const id = app.views[0].id;
    await page.route("https://*.preview.example.net/**", async (route) => {
      const request = route.request(); const url = new URL(request.url());
      const response = await route.fetch({ url: `http://127.0.0.1:${port}${url.pathname}${url.search}`, headers: { ...await request.allHeaders(), host: url.host }, maxRedirects: 0 });
      await route.fulfill({ response });
    });
    await page.route("https://bivy.example/**", (route) => route.fulfill({ contentType: "text/html", body: "<h1>Bivy chat</h1>" }));
    await page.goto(gateway.open(id, "https://bivy.example/sessions/s"));
    const banner = page.locator("#down");
    await expect(banner).toContainText(`Nothing is answering on port ${deadPort}`);
    await expect(page.frameLocator('iframe[title="Ledger"]').getByRole("heading", { name: `Nothing is answering on port ${deadPort}` })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("server-down.png"), fullPage: true });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.screenshot({ path: testInfo.outputPath("server-down-dark.png"), fullPage: true });

    server = http.createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end("<h1>Ledger is back</h1>"); });
    server.listen(deadPort, "127.0.0.1"); await once(server, "listening");
    await expect(page.frameLocator('iframe[title="Ledger"]').getByRole("heading", { name: "Ledger is back" })).toBeVisible({ timeout: 10_000 });
    await expect(banner).toBeHidden();

    server.closeAllConnections(); await new Promise<void>((resolve) => server!.close(() => resolve())); server = undefined;
    await page.reload();
    await page.getByRole("button", { name: "Ask agent to fix" }).click();
    await expect(page).toHaveURL(/^https:\/\/bivy\.example\/share\?session=s&text=/);
    expect(new URL(page.url()).searchParams.get("text")).toContain(`nothing is answering on port ${deadPort}`);
  } finally { server?.close(); fixture.close(); }
});
