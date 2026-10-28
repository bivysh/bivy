// SPDX-License-Identifier: MIT
//
// A widget an agent placed in its message, run by the real ChatView in the real
// frame (packages/web/public/widget-frame.html). What only a browser can show:
// the page runs isolated from the app, picks up the app's look, can answer the
// agent only when the person used it, and keeps what it saved.
import { expect, test, themes, type WebApp } from "./fixtures.js";
import type { Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { widgetFramePolicy } from "../../services/control-plane/src/widget-frame.js";

let server: WebApp;
let origin: string;
test.beforeAll(async ({ webApp }) => {
  server = webApp;
  origin = webApp.origin;
});

// The widget: reports what it can see and reach, sends a choice, saves a counter through
// localStorage (which an opaque origin does not have), and asks for full screen.
const WIDGET = `<!doctype html><html><body>
<p id="isolation"></p><p id="net"></p><p id="data"></p><p id="accent"></p><p id="count"></p>
<button id="pick" class="primary">Pick blue</button>
<button id="big">Bigger</button>
<script>
  try { document.getElementById('isolation').textContent = 'leaked ' + window.parent.document.title; }
  catch (e) { document.getElementById('isolation').textContent = 'isolated'; }
  fetch('https://example.com/').then(function () { document.getElementById('net').textContent = 'online'; }, function () { document.getElementById('net').textContent = 'offline'; });
  bivy.ready(function () {
    document.getElementById('data').textContent = 'question: ' + bivy.data.question;
    document.getElementById('accent').textContent = 'accent: ' + getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    var count = Number(localStorage.getItem('count') || 0) + 1;
    localStorage.setItem('count', String(count));
    document.getElementById('count').textContent = 'opened ' + count;
    // Not caused by the person: must be refused.
    bivy.send('sent on load').then(function () { parent.postMessage('unexpected', '*'); }, function () { document.body.dataset.refused = 'yes'; });
  });
  document.getElementById('pick').onclick = function () { bivy.send('I pick blue'); };
  document.getElementById('big').onclick = function () { bivy.expand(); };
</script></body></html>`;

// The plugin's widget: placed by name, it asks a plugin tool for live data.
const PLUGIN_WIDGET = `<p id="status">waiting</p><script>
  bivy.ready(function () {
    bivy.call('ci_status', { branch: bivy.data.branch }).then(
      function (result) { document.getElementById('status').textContent = result.branch + ': ' + result.state; },
      function (error) { document.getElementById('status').textContent = 'refused: ' + error.message; });
  });
</script>`;

/** Render one assistant message in the real ChatView, with the machine and the
 *  composer stood in for — everything between them and the widget (frame,
 *  protocol, gating) is real — and the frame served under production policy. */
async function mount(page: Page, theme: string, text: string) {
  const html = await server.transformIndexHtml("/widget-test", `<!doctype html><html data-theme="${theme}"><head><title>Bivy app</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root" style="height:100dvh;display:flex;flex-direction:column"></div><script type="module">
    import { createElement as h } from 'react';
    import { createRoot } from 'react-dom/client';
    import '/@fs/${fileURLToPath(new URL("../../packages/ui/tokens.css", import.meta.url))}';
    import '/src/styles.css';
    import { ChatView } from '/src/components/ChatView.tsx';
    import { controller } from '/src/store/useStore.ts';
    window.sent = [];
    window.saved = JSON.parse(sessionStorage.getItem('saved') || '{}');
    controller.sendPrompt = (text) => window.sent.push(text);
    controller.widgetCommand = async (kind, sessionId, fields) => {
      if (kind === 'widgets.state.get') return { states: window.saved };
      if (kind === 'widgets.state.set') {
        window.saved[fields.key] = { state: fields.state };
        sessionStorage.setItem('saved', JSON.stringify(window.saved));
        return {};
      }
      if (kind === 'widgets.source' && fields.name === 'ci') return { widget: { name: 'CI status', html: ${JSON.stringify(PLUGIN_WIDGET).replace(/</g, "\\u003c")} } };
      if (kind === 'widgets.tool' && fields.name === 'ci_status') return { result: { structuredContent: { branch: fields.arguments.branch, state: 'green' } } };
      throw new Error('No plugin on this machine provides a tool called "' + fields.name + '".');
    };
    const real = controller.store.getState;
    controller.store.getState = () => ({ ...real(), activeSession: { ...real().activeSession, activeSessionId: 'test' } });
    createRoot(document.getElementById('root')).render(h(ChatView, {
      entries: [{ id: 'reply', role: 'assistant', text: ${JSON.stringify(text).replace(/</g, "\\u003c")} }],
      working: false, draftRoute: false, sessionKey: 'test',
    }));
    </script></body></html>`);
  await page.route(`${origin}/widget-test`, (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.route(`${origin}/widget-frame.html`, async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), "content-security-policy": widgetFramePolicy(await response.text()) } });
  });
  await page.goto(`${origin}/widget-test`);
}

for (const theme of themes) {
  test(`${theme}: a widget runs isolated, themed, answers when used, and keeps its state`, async ({ page }, testInfo) => {
    const text = [
      "Pick one:",
      "",
      "```bivy",
      JSON.stringify({ type: "widget", title: "Colour", html: WIDGET, data: { question: "Which colour?" } }),
      "```",
    ].join("\n");
    await mount(page, theme, text);

    const frameElement = page.locator(".md-component iframe.widget-frame");
    await expect(frameElement).toHaveAttribute("title", "Colour");
    const widget = page.frameLocator(".md-component iframe.widget-frame");

    // Isolated: the page cannot reach into the app that frames it.
    await expect(widget.locator("#isolation")).toHaveText("isolated");
    await expect(widget.locator("#net")).toHaveText("offline");
    // It got the agent's data and the app's own design tokens.
    await expect(widget.locator("#data")).toHaveText("question: Which colour?");
    const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim());
    await expect(widget.locator("#accent")).toHaveText(`accent: ${accent}`);
    // The frame grew to fit its content rather than scrolling.
    await expect.poll(async () => (await frameElement.boundingBox())!.height).toBeGreaterThan(150);

    await page.screenshot({ path: testInfo.outputPath("widget.png"), fullPage: true });

    // A message the person did not cause is refused; a click sends it.
    await expect(widget.locator("body")).toHaveAttribute("data-refused", "yes");
    await widget.getByRole("button", { name: "Pick blue" }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { sent: string[] }).sent)).toEqual(["I pick blue"]);

    // Full screen is the same running page, restyled in place.
    await widget.getByRole("button", { name: "Bigger" }).click();
    await expect(page.locator(".widget-component")).toHaveAttribute("data-mode", "fullscreen");
    await expect(widget.locator("#count")).toHaveText("opened 1");
    await page.screenshot({ path: testInfo.outputPath("widget-fullscreen.png") });
    await page.getByRole("button", { name: "Done" }).click();
    await expect(page.locator(".widget-component")).toHaveAttribute("data-mode", "inline");

    // What it kept in localStorage was saved for the session and comes back.
    await expect.poll(() => page.evaluate(() => JSON.stringify((window as unknown as { saved: unknown }).saved))).toContain('"count":"1"');
    await page.reload();
    await expect(page.frameLocator(".md-component iframe.widget-frame").locator("#count")).toHaveText("opened 2");
  });

  test(`${theme}: a plugin's widget is placed by name and gets live data from a plugin tool`, async ({ page }) => {
    await mount(page, theme, ["CI:", "", "```bivy", JSON.stringify({ type: "widget", widget: "ci", data: { branch: "main" } }), "```"].join("\n"));
    await expect(page.locator(".md-component iframe.widget-frame")).toHaveAttribute("title", "CI status");
    await expect(page.frameLocator(".md-component iframe.widget-frame").locator("#status")).toHaveText("main: green");
  });
}
