// SPDX-License-Identifier: AGPL-3.0-only
//
// An app framed inside a message, and the property that makes it acceptable:
// a bearer launch URL is minted only when the frame is actually going to be
// looked at.
//
// `AppMessage` keeps that property by waiting for a click. A frame has no
// click, so it waits for the frame to scroll into view. This spec exists to
// prove that distinction holds, because it is the whole reason the inline
// frame is allowed to exist — a unit test cannot see it, and a reviewer
// reading the component has to take the IntersectionObserver on trust.
import { expect, test, themes, type WebApp } from "./fixtures.js";
import { fileURLToPath } from "node:url";

let server: WebApp;
let origin: string;
test.beforeAll(async ({ webApp }) => {
  server = webApp;
  origin = webApp.origin;
});

/** The app sits at the TOP of a long message. The chat pins itself to the
 *  newest line on mount, so this is what puts the frame off screen to begin
 *  with — filler above it would be scrolled past and the app would be in view
 *  immediately, which is the mistake the first version of this spec made. */
function page(theme: string, appOrigin: string) {
  return `<!doctype html><html data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root" style="height:100dvh;display:flex;flex-direction:column"></div><script type="module">
    import { createElement as h } from 'react';
    import { createRoot } from 'react-dom/client';
    import '/@fs/${fileURLToPath(new URL('../../packages/ui/tokens.css', import.meta.url))}';
    import '/src/styles.css';
    import { ChatView } from '/src/components/ChatView.tsx';
    import { controller } from '/src/store/useStore.ts';

    // Record every app command, so the test can assert WHEN each was made.
    window.__appCalls = [];
    controller.appCommand = async (name, sessionId, payload) => {
      window.__appCalls.push(name);
      if (name === 'apps.list') return { apps: [{ id: 'app-7f2a', name: 'Checkout', views: [{ id: 'v1', kind: 'web', name: 'Web', source: 'service' }] }] };
      if (name === 'apps.open') return { kind: 'web', url: '${appOrigin}/preview' };
      return {};
    };

    const filler = Array.from({ length: 40 }, (_, i) => 'Paragraph ' + i + '.').join('\\n\\n');
    createRoot(document.getElementById('root')).render(h(ChatView, {
      entries: [{ id: 'reply', role: 'assistant', text: '::view{app=app-7f2a caption="The checkout"}\\n\\n' + filler }],
      working: false, draftRoute: false, sessionKey: 's1',
    }));
    </script></body></html>`;
}

for (const theme of themes) {
  test(`${theme}: an inline app resolves only once it is scrolled into view`, async ({ page: tab }, testInfo) => {
    await tab.setViewportSize({ width: 390, height: 700 });
    // Stand in for the preview origin the machine would return.
    await tab.route("**/preview", (route) => route.fulfill({ contentType: "text/html", body: "<h1>Checkout preview</h1>" }));
    const html = await server.transformIndexHtml("/inline-app-test", page(theme, "https://preview.test"));
    await tab.route(`${origin}/inline-app-test`, (route) => route.fulfill({ contentType: "text/html", body: html }));
    await tab.goto(`${origin}/inline-app-test`);

    // The chat opens at its newest line, far below the app. Nothing has been
    // asked of the machine yet.
    await expect(tab.getByText("Paragraph 39.")).toBeVisible();
    expect(await tab.evaluate(() => (window as never as { __appCalls: string[] }).__appCalls)).toEqual([]);

    // Scrolling to it is what resolves it.
    await tab.locator(".inline-app-card, .inline-app").scrollIntoViewIfNeeded();
    await expect(tab.locator("iframe.inline-app-frame")).toBeVisible({ timeout: 10_000 });
    expect(await tab.evaluate(() => (window as never as { __appCalls: string[] }).__appCalls)).toEqual(["apps.list", "apps.open"]);

    // The caption names it, and the full-screen route out stays available.
    await expect(tab.getByText("The checkout")).toBeVisible();
    await expect(tab.getByRole("button", { name: "Open full screen" })).toBeVisible();
    await tab.screenshot({ path: testInfo.outputPath("inline-app.png") });
  });
}

test("an app that is gone says so, and still offers to open", async ({ page: tab }) => {
  await tab.setViewportSize({ width: 390, height: 700 });
  const html = await server.transformIndexHtml(
    "/inline-app-missing",
    page("light", "https://preview.test").replace(
      "if (name === 'apps.list') return { apps: [{ id: 'app-7f2a', name: 'Checkout', views: [{ id: 'v1', kind: 'web', name: 'Web', source: 'service' }] }] };",
      "if (name === 'apps.list') return { apps: [] };",
    ),
  );
  await tab.route(`${origin}/inline-app-missing`, (route) => route.fulfill({ contentType: "text/html", body: html }));
  await tab.goto(`${origin}/inline-app-missing`);
  await tab.locator(".inline-app-card").scrollIntoViewIfNeeded();
  await expect(tab.getByText("not published on the machine any more")).toBeVisible({ timeout: 10_000 });
  // No frame, and apps.open was never reached — there was nothing to open.
  await expect(tab.locator("iframe.inline-app-frame")).toHaveCount(0);
  expect(await tab.evaluate(() => (window as never as { __appCalls: string[] }).__appCalls)).toEqual(["apps.list"]);
});
