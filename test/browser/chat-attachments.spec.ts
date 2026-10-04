// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, themes, type WebApp } from "./fixtures.js";
import { fileURLToPath } from "node:url";

let server: WebApp;
let origin: string;
test.beforeAll(async ({ webApp }) => {
  server = webApp;
  origin = webApp.origin;
});

// The tall test image is height-bound at any width; the phone width is the
// stricter case for the card row and the fitted gallery.
for (const theme of themes) for (const width of [390]) {
  test(`${theme} ${width}: attachment cards and fitted gallery`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 800 });
    const html = await server.transformIndexHtml('/attachment-test', `<!doctype html><html data-theme="${theme}"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root" style="height:100dvh;display:flex;flex-direction:column"></div><script type="module">
      import { createElement as h } from 'react';
      import { createRoot } from 'react-dom/client';
      import '/@fs/${fileURLToPath(new URL('../../packages/ui/tokens.css', import.meta.url))}';
      import '/src/styles.css';
      import { ChatView } from '/src/components/ChatView.tsx';
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="2400"><rect width="600" height="2400" fill="lightblue"/><text x="30" y="80" font-size="36">Tall screenshot</text><text x="30" y="2350" font-size="36">Bottom of image</text></svg>';
      createRoot(document.getElementById('root')).render(h(ChatView, { entries: [{ id: 'reply', role: 'assistant', text: 'Here are the files.', attachments: [
        { kind: 'image', name: 'screenshot.png', description: 'The complete invoice workbench.', mimeType: 'image/svg+xml', size: 250, data: btoa(svg) },
        { kind: 'file', name: 'invoice-export-with-a-very-long-filename.csv', description: 'Invoices ready for review and download.', mimeType: 'text/csv', size: 12, data: btoa('name,total') },
        { kind: 'file', name: 'unavailable.csv', mimeType: 'text/csv', size: 12, omitted: true }
      ] }], working: false, draftRoute: false, sessionKey: 'test' }));
      </script></body></html>`);
    await page.route(`${origin}/attachment-test`, route => route.fulfill({ contentType: 'text/html', body: html }));
    await page.goto(`${origin}/attachment-test`);
    await expect(page.getByText('The complete invoice workbench.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Download unavailable.csv unavailable' })).toBeDisabled();
    const file = page.getByRole('link', { name: 'Download invoice-export-with-a-very-long-filename.csv' });
    await file.focus();
    await expect(file).toBeFocused();
    const download = page.waitForEvent('download');
    await file.press('Enter');
    expect((await download).suggestedFilename()).toBe('invoice-export-with-a-very-long-filename.csv');
    await page.screenshot({ path: testInfo.outputPath('cards.png') });
    await page.locator('.attach-preview').click();
    const image = page.locator('.image-viewer-img');
    await expect(image).toBeVisible();
    const box = (await image.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(800);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(box.height / box.width).toBeCloseTo(4, 1);
    await page.screenshot({ path: testInfo.outputPath('gallery.png') });
    const chat = page.locator('.chat');
    const scrollBefore = await chat.evaluate(el => el.scrollTop);
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Fit image' })).toHaveText('150%');
    const enlarged = (await image.boundingBox())!;
    expect(enlarged.height).toBeCloseTo(box.height * 1.5, 0);
    await page.mouse.move(width / 2, 400);
    await page.mouse.wheel(0, 150);
    await expect.poll(async () => (await image.boundingBox())!.y).toBeLessThan(enlarged.y);
    expect(await chat.evaluate(el => el.scrollTop)).toBe(scrollBefore);
    expect(await page.evaluate(() => window.visualViewport!.scale)).toBe(1);
    await page.screenshot({ path: testInfo.outputPath('gallery-zoomed.png') });
    await page.getByRole('button', { name: 'Fit image' }).click();
    await expect(page.getByRole('button', { name: 'Zoom out', exact: true })).toBeDisabled();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 160, y: 350, id: 1 }, { x: 230, y: 450, id: 2 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 100, y: 250, id: 1 }, { x: 290, y: 550, id: 2 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(async () => (await image.boundingBox())!.height).toBeGreaterThan(box.height * 2);
    const pinched = (await image.boundingBox())!;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 200, y: 500, id: 1 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 150, y: 300, id: 1 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(async () => (await image.boundingBox())!.y).toBeLessThan(pinched.y);
    expect(await chat.evaluate(el => el.scrollTop)).toBe(scrollBefore);
    expect(await page.evaluate(() => window.visualViewport!.scale)).toBe(1);
    await cdp.detach();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
}

test('gallery keeps panning separate from navigation and resets each image', async ({ page }) => {
  const html = await server.transformIndexHtml('/gallery-test', `<!doctype html><html><body><div id="root"></div><script type="module">
    import { createElement as h } from 'react';
    import { createRoot } from 'react-dom/client';
    import '/@fs/${fileURLToPath(new URL('../../packages/ui/tokens.css', import.meta.url))}';
    import '/src/styles.css';
    import { ImageGallery } from '/src/components/ImageGallery.tsx';
    const data = btoa('<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><rect width="1600" height="900" fill="lightblue"/></svg>');
    createRoot(document.getElementById('root')).render(h(ImageGallery, {
      images: ['first.svg', 'second.svg'].map(name => ({kind:'image', name, mimeType:'image/svg+xml', data})), index:0, onClose:() => {}
    }));
    </script></body></html>`);
  await page.route(`${origin}/gallery-test`, route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(`${origin}/gallery-test`);
  await expect(page.getByRole('button', { name: 'Zoom in', exact: true })).toBeEnabled();
  await page.keyboard.press('+');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('img', { name: 'first.svg' })).toBeVisible();
  await page.getByRole('button', { name: 'Next image' }).click();
  await expect(page.getByRole('img', { name: 'second.svg' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Fit image' })).toHaveText('100%');
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('img', { name: 'first.svg' })).toBeVisible();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: 'Close', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Fit image' })).toBeFocused();
});
