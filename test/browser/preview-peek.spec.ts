// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, themes } from "./fixtures.js";
import path from "node:path";

for (const theme of themes) {
  test(`preview fills the mobile viewport (${theme})`, async ({ page, webApp, isMobile }, testInfo) => {
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
    if (isMobile) {
      await expect.poll(() => body.boundingBox()).toEqual({ x: 0, y: 0, ...viewport });
      const frame = await dialog.locator('iframe').boundingBox();
      expect(frame!.x).toBe(0);
      expect(frame!.width).toBe(viewport.width);
      expect(frame!.y + frame!.height).toBe(viewport.height);
    } else {
      expect((await body.boundingBox())!.width).toBeLessThan(viewport.width);
    }
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
