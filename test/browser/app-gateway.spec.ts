// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "./fixtures.js";
import type { FrameLocator, Locator, Page } from "@playwright/test";
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

/** Taps an element while pointing. The layer that takes the tap arrives by
 * message; once it covers the page, the tap lands on it as a finger's would. */
async function pointAt(app: Page | FrameLocator, target: Locator): Promise<void> {
  await expect(app.locator('html > div[aria-hidden="true"]')).toHaveCount(2);
  await target.click({ force: true });
}

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
      // A revision long poll can still be open when the fixture shuts down.
      const response = await route.fetch({ url: `http://127.0.0.1:${port}${url.pathname}${url.search}`, headers: { ...await request.allHeaders(), host: url.host }, maxRedirects: 0 }).catch(() => undefined);
      await (response ? route.fulfill({ response }) : route.abort()).catch(() => {});
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
    // An agent turn that rebuilds the output reloads the open preview.
    await fs.writeFile(path.join(dir, "index.html"), '<!doctype html><html lang="en"><title>Generated app</title><h1>Rebuilt by the agent</h1></html>');
    registry.touch("s");
    await expect(content.getByRole("heading", { name: "Rebuilt by the agent" })).toBeVisible();
    await expect(page.getByText("Updated after the agent’s turn")).toBeVisible();
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
      // A revision long poll can still be open when the fixture shuts down.
      const response = await route.fetch({ url: `http://127.0.0.1:${port}${url.pathname}${url.search}`, headers: { ...await request.allHeaders(), host: url.host }, maxRedirects: 0 }).catch(() => undefined);
      await (response ? route.fulfill({ response }) : route.abort()).catch(() => {});
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

// The pill's tools work through the inspector the gateway injects, even when
// the app ships a strict CSP: console errors are counted, pointing at an
// element drafts context for the agent, and the lens constrains the width.
test("inspector reports console errors and pointed elements to the pill", async ({ page }, testInfo) => {
  const registry = new AppRegistry();
  const fixture = await delivery(registry, false);
  const { gateway, port } = fixture;
  const app = http.createServer((req, res) => {
    if (req.url === "/app.js") { res.setHeader("content-type", "text/javascript"); res.end('console.error("Ledger failed to load totals");document.getElementById("save").onclick=()=>history.pushState(null,"","/saved");'); return; }
    res.setHeader("content-type", "text/html"); res.setHeader("content-security-policy", "default-src 'self'; script-src 'self'");
    res.end('<!doctype html><html lang="en"><head><title>Ledger</title></head><body><main><h1>Ledger</h1><button id="save" class="cta primary">Add transaction</button></main><script src="/app.js"></script></body></html>');
  });
  app.listen(0, "127.0.0.1"); await once(app, "listening");
  try {
    const published = registry.publish("s", os.tmpdir(), { version: 1, name: "Ledger", views: [{ kind: "web", name: "Ledger", source: { kind: "service", port: (app.address() as { port: number }).port } }] });
    const id = published.views[0].id;
    await page.route("https://*.preview.example.net/**", async (route) => {
      const request = route.request(); const url = new URL(request.url());
      const response = await route.fetch({ url: `http://127.0.0.1:${port}${url.pathname}${url.search}`, headers: { ...await request.allHeaders(), host: url.host, "sec-fetch-dest": request.resourceType() === "document" ? (request.frame().parentFrame() ? "iframe" : "document") : "empty" }, maxRedirects: 0 }).catch(() => undefined);
      await (response ? route.fulfill({ response }) : route.abort()).catch(() => {});
    });
    await page.route("https://bivy.example/**", (route) => route.fulfill({ contentType: "text/html", body: "<h1>Bivy chat</h1>" }));
    await page.goto(gateway.open(id, "https://bivy.example/sessions/s"));
    const content = page.frameLocator('iframe[title="Ledger"]');
    await expect(content.getByRole("heading", { name: "Ledger" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Console, 1 error" })).toBeVisible();
    await page.getByRole("button", { name: "Console, 1 error" }).click();
    await expect(page.getByRole("region", { name: "Console" })).toContainText("Ledger failed to load totals");
    await page.screenshot({ path: testInfo.outputPath("pill-console.png") });

    await page.getByRole("button", { name: "Point" }).click();
    await expect(page.getByText("Tap anything in the app to point at it.")).toBeVisible();
    await pointAt(content, content.getByRole("button", { name: "Add transaction" }));
    const draftBox = page.getByRole("textbox", { name: "What should change?" });
    await expect(draftBox).toBeFocused();
    // Under 16px, iOS zooms the shell on focus and it stays zoomed.
    await expect(draftBox).toHaveCSS("font-size", "16px");
    const context = await page.locator("#draft-context").textContent();
    expect(context).toContain('#save ("Add transaction")');
    expect(context).toContain("Ledger failed to load totals");
    await page.screenshot({ path: testInfo.outputPath("pill-draft.png") });
    // Pointing kept the tap from the app, whose own handler never ran; right
    // after, the app takes taps again.
    await page.getByRole("button", { name: "Cancel" }).click();
    await content.getByRole("button", { name: "Add transaction" }).click();

    await page.getByRole("radio", { name: "Phone" }).click();
    await expect.poll(() => page.locator("iframe").evaluate((el) => el.getBoundingClientRect().width)).toBeLessThanOrEqual(391);
    await page.emulateMedia({ colorScheme: "dark" });
    await page.screenshot({ path: testInfo.outputPath("pill-lens-dark.png") });

    await page.setViewportSize({ width: 390, height: 844 });
    // Controls collapse out of the app's way and come back.
    await page.getByRole("button", { name: "Hide Bivy controls" }).click();
    await expect(page.getByRole("navigation", { name: "Bivy preview controls" })).toBeHidden();
    await page.getByRole("button", { name: "Show Bivy controls" }).click();
    await expect(page.getByRole("radiogroup", { name: "Preview width" })).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("pill-mobile-dark.png") });
    await page.getByRole("button", { name: "Point" }).click();
    await pointAt(content, content.getByRole("heading", { name: "Ledger" }));
    await expect(draftBox).toBeFocused();
    await page.keyboard.type("Make the title bigger");
    await page.getByRole("button", { name: "Add to chat" }).click();
    await expect(page).toHaveURL(/^https:\/\/bivy\.example\/share\?session=s&text=/);
    expect(new URL(page.url()).searchParams.get("text")).toMatch(/^Make the title bigger[\s\S]*page \/saved/);
  } finally { app.close(); app.closeAllConnections(); fixture.close(); }
});

// Peek: a Bivy page frames the shell, which frames the app. The app's cookie
// is third-party there, so the embedded launch sets a Partitioned cookie, and
// drafts go to the framing Bivy page by message instead of navigating.
test("the preview works framed inside Bivy and hands drafts to it", async ({ page }, testInfo) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bivy-peek-"));
  const registry = new AppRegistry();
  const fixture = await delivery(registry, false);
  const { gateway, port } = fixture;
  try {
    await fs.writeFile(path.join(dir, "index.html"), '<!doctype html><html lang="en"><title>Ledger</title><h1>Ledger</h1><button id="save">Add transaction</button></html>');
    const id = registry.publish("s", dir, { version: 1, name: "Ledger", views: [{ kind: "web", name: "Ledger", source: { kind: "static", directory: "." } }] }).views[0].id;
    await page.route("https://*.preview.example.net/**", async (route) => {
      const request = route.request(); const url = new URL(request.url());
      const response = await route.fetch({ url: `http://127.0.0.1:${port}${url.pathname}${url.search}`, headers: { ...await request.allHeaders(), host: url.host }, maxRedirects: 0 }).catch(() => undefined);
      await (response ? route.fulfill({ response }) : route.abort()).catch(() => {});
    });
    const shellUrl = gateway.open(id, "https://bivy.example/sessions/s");
    await page.route("https://bivy.example/chat", (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><html lang="en"><title>Bivy</title><body><script>window.drafts=[];addEventListener("message",e=>{if(e.data&&e.data.source==="bivy-preview"&&e.data.type!=="hello")window.drafts.push(e.data);});</script><iframe title="Peek" style="width:800px;height:600px" sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-popups" src="${shellUrl}"></iframe></body></html>` }));
    await page.goto("https://bivy.example/chat");
    const shell = page.frameLocator('iframe[title="Peek"]');
    const app = shell.frameLocator('iframe[title="Ledger"]');
    await expect(app.getByRole("heading", { name: "Ledger" })).toBeVisible();
    await expect(shell.getByRole("button", { name: "Back to chat" })).toBeHidden();
    await page.screenshot({ path: testInfo.outputPath("peek-embedded.png") });
    await shell.getByRole("button", { name: "Point" }).click();
    await pointAt(app, app.getByRole("button", { name: "Add transaction" }));
    await expect(shell.getByRole("textbox", { name: "What should change?" })).toBeFocused();
    await page.keyboard.type("Use a plus icon");
    await shell.getByRole("button", { name: "Add to chat" }).click();
    await expect.poll(() => page.evaluate(() => (window as any).drafts)).toEqual([expect.objectContaining({ type: "draft", text: expect.stringMatching(/^Use a plus icon\n\nIn the app preview "Ledger"/) })]);
    await expect(page).toHaveURL("https://bivy.example/chat");

    // A browser that refuses the framed cookie is detected and reported, so
    // Bivy can fall back to a tab instead of showing a dead frame.
    await page.route("https://*.preview.example.net/__bivy/redeem", async (route) => {
      const request = route.request(); const url = new URL(request.url());
      const response = await route.fetch({ url: `http://127.0.0.1:${port}${url.pathname}`, headers: { ...await request.allHeaders(), host: url.host } });
      await route.fulfill({ status: response.status(), headers: Object.fromEntries(Object.entries(response.headers()).filter(([key]) => key !== "set-cookie")) });
    });
    await page.context().clearCookies();
    // A fresh frame, as the drawer mounts one per open (a fragment-only change wouldn't reload).
    await page.evaluate((url) => { (window as any).drafts = []; const old = document.querySelector("iframe")!; const next = old.cloneNode() as HTMLIFrameElement; next.src = url; old.replaceWith(next); }, gateway.open(id, "https://bivy.example/sessions/s"));
    await expect.poll(() => page.evaluate(() => (window as any).drafts)).toEqual([{ source: "bivy-preview", type: "blocked" }]);
  } finally { fixture.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

// Point and speak, end to end: Bivy's real drawer (PreviewPeek) frames the
// real shell and app. The drawer does the listening — a stubbed microphone
// and transcription stand in for the device and the node — and only the
// transcript reaches the shell's draft box, spoken words first.
test("point and speak: hold the mic or long-press while pointing, and the words lead the draft", async ({ page, webApp }, testInfo) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bivy-speak-"));
  const registry = new AppRegistry();
  const gateway = new AppGateway(registry, "https://{app}.preview.example.net", () => [webApp.origin]);
  gateway.server.listen(0, "127.0.0.1"); await once(gateway.server, "listening");
  const port = (gateway.server.address() as { port: number }).port;
  try {
    await fs.writeFile(path.join(dir, "index.html"), '<!doctype html><html lang="en"><title>Checkout</title><h1>Your bag</h1><p>Total $102</p><button id="pay" onclick="document.getElementById(\'paid\').textContent=String(+document.getElementById(\'paid\').textContent+1)">Pay now</button><output id="paid">0</output></html>');
    const id = registry.publish("s", dir, { version: 1, name: "Checkout", views: [{ kind: "web", name: "Checkout", source: { kind: "static", directory: "." } }] }).views[0].id;
    await page.route("https://*.preview.example.net/**", async (route) => {
      const request = route.request(); const url = new URL(request.url());
      const response = await route.fetch({ url: `http://127.0.0.1:${port}${url.pathname}${url.search}`, headers: { ...await request.allHeaders(), host: url.host }, maxRedirects: 0 }).catch(() => undefined);
      await (response ? route.fulfill({ response }) : route.abort()).catch(() => {});
    });
    const shellUrl = gateway.open(id, `${webApp.origin}/sessions/s`);
    const html = await webApp.transformIndexHtml("/speak-test", `<html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module">
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { PreviewPeek } from '/src/components/PreviewPeek.tsx';
      import { controller } from '/src/store/controller.ts';
      import '/@fs/${path.resolve("packages/ui/tokens.css")}';
      import '/src/styles.css';
      controller.store.setStatus('online');
      window.drafts = []; window.transcribed = [];
      controller.prefillComposer = (text) => { window.drafts.push(text); return true; };
      controller.transcribe = async (audio, mimeType) => { window.transcribed.push({ bytes: audio.length, mimeType }); return 'give it more room above the home bar'; };
      // A microphone that hears a tone.
      navigator.mediaDevices.getUserMedia = async () => { const ctx = new AudioContext(); const tone = ctx.createOscillator(); const out = ctx.createMediaStreamDestination(); tone.connect(out); tone.start(); return out.stream; };
      createRoot(document.getElementById('root')).render(React.createElement(PreviewPeek, { url: ${JSON.stringify(shellUrl)}, name: 'Checkout', sessionId: 's', onClose() {}, onOpenInTab() {} }));
    </script></body></html>`);
    await page.route(`${webApp.origin}/speak-test`, (route) => route.fulfill({ contentType: "text/html", body: html }));
    await page.goto(`${webApp.origin}/speak-test`);
    const shell = page.frameLocator('iframe[title="Checkout"]');
    const app = shell.frameLocator('iframe[title="Checkout"]');
    await expect(app.getByRole("heading", { name: "Your bag" })).toBeVisible();

    // Point, then hold the mic in the draft box.
    await shell.getByRole("button", { name: "Point" }).click();
    await expect(shell.getByText("Hold to point and speak.")).toBeVisible();
    await pointAt(app, app.getByRole("button", { name: "Pay now" }));
    const mic = shell.getByRole("button", { name: "Speak" });
    await mic.hover(); await page.mouse.down();
    await expect(page.getByRole("group", { name: "Voice recording" })).toBeVisible();
    await expect(shell.getByRole("status").filter({ hasText: "Listening" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("point-and-speak-listening.png") });
    await page.waitForTimeout(600);
    await page.mouse.up();
    const box = shell.getByRole("textbox", { name: "What should change?" });
    await expect(box).toHaveValue("give it more room above the home bar");
    await page.screenshot({ path: testInfo.outputPath("point-and-speak-draft.png") });
    expect((await page.evaluate(() => (window as any).transcribed))[0].bytes).toBeGreaterThan(0);
    await shell.getByRole("button", { name: "Add to chat" }).click();
    await expect.poll(() => page.evaluate(() => (window as any).drafts)).toEqual([expect.stringMatching(/^give it more room above the home bar\n\nIn the app preview "Checkout" \(page \/[^)]*\):\nElement: #pay \("Pay now"\)/)]);

    // Long-press while pointing: the draft opens listening; letting go stops,
    // and the press never reaches the app.
    await shell.getByRole("button", { name: "Point" }).click();
    await expect(app.locator('html > div[aria-hidden="true"]')).toHaveCount(2);
    const pay = await app.getByRole("button", { name: "Pay now" }).boundingBox();
    await page.mouse.move(pay!.x + pay!.width / 2, pay!.y + pay!.height / 2);
    await page.mouse.down();
    await expect(page.getByRole("group", { name: "Voice recording" })).toBeVisible();
    await page.waitForTimeout(400);
    await page.mouse.up();
    await expect(box).toHaveValue("give it more room above the home bar");
    await expect(shell.locator("#draft-context")).toContainText("Element: #pay");
    await expect(app.locator("#paid")).toHaveText("0");
    await expect(app.locator('html > div[aria-hidden="true"]')).toHaveCount(0);
  } finally { gateway.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

// A stable address on a home screen: the signed-out redirect is covered in
// test/apps.test.ts. Here, the return leg: the signed-in client's one-use
// direct link lands on the same page, unframed.
test("a stable address, and a review card's Open preview, land on the same page", async ({ page }) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bivy-address-"));
  const registry = new AppRegistry();
  const fixture = await delivery(registry, false);
  const gateway = fixture.gateway as AppGateway;
  try {
    await fs.writeFile(path.join(dir, "index.html"), '<!doctype html><html lang="en"><title>Ledger</title><h1>Ledger</h1><script>document.body.append(location.pathname)</script></html>');
    const id = registry.publish("s", dir, { version: 1, name: "Ledger", views: [{ kind: "web", name: "Ledger", source: { kind: "static", directory: "." } }] }).views[0].id;
    await page.route("https://*.preview.example.net/**", async (route) => {
      const request = route.request(); const url = new URL(request.url());
      const response = await route.fetch({ url: `http://127.0.0.1:${fixture.port}${url.pathname}${url.search}`, headers: { ...await request.allHeaders(), host: url.host }, maxRedirects: 0 }).catch(() => undefined);
      await (response ? route.fulfill({ response }) : route.abort()).catch(() => {});
    });
    await page.goto(`${gateway.openDirect(id)}~${encodeURIComponent("/invoices")}`);
    await expect(page).toHaveURL(`${gateway.origin(id)}/invoices`);
    await expect(page.getByRole("heading", { name: "Ledger" })).toBeVisible();
    await expect(page.locator("body")).toContainText("/invoices");
    expect(await page.evaluate(() => window.top === window)).toBe(true);
    // A review card opens the preview shell on the page its screenshot shows.
    await page.goto(`${gateway.open(id, "https://bivy.example/sessions/s")}~${encodeURIComponent("/checkout")}`);
    await expect(page.frameLocator("#app").locator("body")).toContainText("/checkout");
  } finally { fixture.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

// Compare shows the last two screenshots around the agent's change, with a
// handle that reveals more of either. (Taking the shots is covered in
// test/app-screenshot.test.ts; here, the shell's side.)
test("Compare shows before and after the agent's last change", async ({ page }, testInfo) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bivy-compare-"));
  const registry = new AppRegistry();
  const fixture = await delivery(registry, false);
  const { gateway, port } = fixture;
  try {
    await fs.writeFile(path.join(dir, "index.html"), '<!doctype html><html lang="en"><title>Ledger</title><h1>Ledger</h1></html>');
    const id = registry.publish("s", dir, { version: 1, name: "Ledger", views: [{ kind: "web", name: "Ledger", source: { kind: "static", directory: "." } }] }).views[0]!.id;
    await page.setContent('<body style="margin:0;background:#c33;width:390px;height:600px"></body>');
    const before = await page.screenshot({ clip: { x: 0, y: 0, width: 390, height: 600 } });
    await page.setContent('<body style="margin:0;background:#3a3;width:390px;height:600px"></body>');
    const after = await page.screenshot({ clip: { x: 0, y: 0, width: 390, height: 600 } });
    registry.getView(id)!.shots = [{ revision: 0, at: 1, png: before }, { revision: 1, at: 2, png: after }];
    await page.route("https://*.preview.example.net/**", async (route) => {
      const request = route.request(); const url = new URL(request.url());
      const response = await route.fetch({ url: `http://127.0.0.1:${port}${url.pathname}${url.search}`, headers: { ...await request.allHeaders(), host: url.host }, maxRedirects: 0 }).catch(() => undefined);
      await (response ? route.fulfill({ response }) : route.abort()).catch(() => {});
    });
    await page.goto(gateway.open(id));
    await page.getByRole("button", { name: "Compare" }).click();
    const panel = page.getByRole("region", { name: "Before and after the agent’s last change" });
    await expect.poll(() => panel.getByRole("img", { name: "Before the agent’s last change" }).evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(390);
    await panel.getByRole("slider").fill("20");
    expect(await panel.getByRole("img", { name: "Before the agent’s last change" }).evaluate((img: HTMLElement) => img.style.clipPath)).toBe("inset(0px 80% 0px 0px)");
    await page.screenshot({ path: testInfo.outputPath("compare.png") });
  } finally { fixture.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

// Someone with a shared link sees the app unframed with one extra control:
// point at an element, write a note, send it. The owner gets it in Apps.
test("a reviewer on a shared link can pin a note to an element", async ({ page }, testInfo) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bivy-review-"));
  const registry = new AppRegistry();
  const fixture = await delivery(registry, false);
  const gateway = fixture.gateway as AppGateway;
  try {
    await fs.writeFile(path.join(dir, "index.html"), '<!doctype html><html lang="en"><head><title>Ledger</title></head><body><h1>Ledger</h1><button class="cta">Add transaction</button></body></html>');
    const id = registry.publish("s", dir, { version: 1, name: "Ledger", views: [{ kind: "web", name: "Ledger", source: { kind: "static", directory: "." } }] }).views[0]!.id;
    await page.route("https://*.preview.example.net/**", async (route) => {
      const request = route.request(); const url = new URL(request.url());
      const response = await route.fetch({ url: `http://127.0.0.1:${fixture.port}${url.pathname}${url.search}`, headers: { ...await request.allHeaders(), host: url.host, ...(request.isNavigationRequest() ? { "sec-fetch-dest": "document" } : {}) }, maxRedirects: 0 }).catch(() => undefined);
      await (response ? route.fulfill({ response }) : route.abort()).catch(() => {});
    });
    await page.goto(gateway.share(id).url);
    await page.getByRole("button", { name: "Leave a note" }).click();
    await expect(page.getByText("Tap the part of the page your note is about.")).toBeVisible();
    await pointAt(page, page.getByRole("button", { name: "Add transaction" }));
    // Under 16px, iOS zooms the page in when the note box takes focus.
    await expect(page.getByRole("textbox", { name: "Your note" })).toHaveCSS("font-size", "16px");
    await page.getByRole("textbox", { name: "Your note" }).fill("Use a plus icon here");
    await page.screenshot({ path: testInfo.outputPath("reviewer-note.png") });
    await page.getByRole("button", { name: "Send note" }).click();
    await expect(page.getByText("Sent. Thanks")).toBeVisible();
    expect(registry.getView(id)!.notes).toEqual([expect.objectContaining({ note: "Use a plus icon here", selector: "button.cta", text: "Add transaction", path: "/" })]);
  } finally { fixture.close(); await fs.rm(dir, { recursive: true, force: true }); }
});
