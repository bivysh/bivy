// SPDX-License-Identifier: MIT
import { expect, test, themes } from "./fixtures.js";
import path from "node:path";

for (const theme of themes) {
  test(`preview fills the viewport (${theme})`, async ({ page, webApp, isMobile }, testInfo) => {
    const html = await webApp.transformIndexHtml('/preview-layout', `<html data-theme="${theme}"><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module">
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { PreviewPeek } from '/src/components/PreviewPeek.tsx';
      import '/@fs/${path.resolve("packages/ui/tokens.css")}';
      import '/src/styles.css';
      import '/src/ux-cleanup.css';
      const root = createRoot(document.getElementById('root'));
      root.render(React.createElement(PreviewPeek, {
        url: location.origin + '/preview-content', name: 'Website and invoice editor', sessionId: 's',
        onClose: () => root.unmount(), onOpenInTab() {},
      }));
    </script></body></html>`);
    await page.route(`${webApp.origin}/preview-layout`, route => route.fulfill({ contentType: 'text/html', body: html }));
    await page.route(`${webApp.origin}/preview-content`, route => route.fulfill({ contentType: 'text/html', body: '<h1>App preview</h1><button>Continue</button>' }));
    await page.goto(`${webApp.origin}/preview-layout`);
    const dialog = page.getByRole('dialog', { name: 'Preview: Website and invoice editor' });
    const body = dialog.locator('.sheet-body');
    await expect(body).toBeVisible();
    const viewport = page.viewportSize()!;
    await expect.poll(() => body.boundingBox()).toEqual({ x: 0, y: 0, ...viewport });
    const frame = await dialog.locator('iframe').boundingBox();
    expect(frame!.x).toBe(0);
    expect(frame!.width).toBe(viewport.width);
    expect(frame!.y + frame!.height).toBe(viewport.height);
    await page.screenshot({ path: testInfo.outputPath(`preview-${theme}.png`) });
    if (isMobile) {
      // viewport.ts publishes visual-viewport dimensions when the keyboard opens.
      await page.evaluate(() => {
        document.documentElement.style.setProperty('--app-h', '500px');
        document.documentElement.style.setProperty('--app-top', '20px');
      });
      await expect.poll(() => body.boundingBox()).toEqual({ x: 0, y: 20, width: viewport.width, height: 500 });
    }
    await dialog.getByRole('button', { name: 'Close', exact: true }).focus();
    await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);
  });
}

// iOS zooms Bivy's page for a pinch inside the preview frame. That magnifies
// the page; it must not re-lay the shell into the zoomed region the way the
// keyboard does, or the header and overlays grow over the app.
test('pinch-zoom magnifies the preview instead of re-laying the shell', async ({ page, webApp, isMobile }) => {
  test.skip(!isMobile, 'pinch-zoom needs a mobile viewport');
  const html = await webApp.transformIndexHtml('/preview-pinch', `<html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module">
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { PreviewPeek } from '/src/components/PreviewPeek.tsx';
    import { initViewport } from '/src/viewport.ts';
    import '/@fs/${path.resolve("packages/ui/tokens.css")}';
    import '/src/styles.css';
    initViewport();
    createRoot(document.getElementById('root')).render(React.createElement(PreviewPeek, {
      url: location.origin + '/preview-content', name: 'Zoomed app', sessionId: 's', onClose() {}, onOpenInTab() {},
    }));
  </script></body></html>`);
  await page.route(`${webApp.origin}/preview-pinch`, route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.route(`${webApp.origin}/preview-content`, route => route.fulfill({ contentType: 'text/html', body: '<h1>App preview</h1>' }));
  await page.goto(`${webApp.origin}/preview-pinch`);
  const body = page.getByRole('dialog', { name: 'Preview: Zoomed app' }).locator('.sheet-body');
  const viewport = page.viewportSize()!;
  await expect.poll(() => body.boundingBox()).toEqual({ x: 0, y: 0, ...viewport });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2.5 });
  await expect.poll(() => page.evaluate(() => window.visualViewport!.scale)).toBeGreaterThan(1.5);
  const appHeight = () => page.evaluate(() => document.documentElement.style.getPropertyValue('--app-h'));
  expect(await appHeight()).toBe(`${viewport.height}px`);
  await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
  await expect.poll(() => page.evaluate(() => window.visualViewport!.scale)).toBe(1);
  await cdp.detach();
  expect(await appHeight()).toBe(`${viewport.height}px`);
});
