// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "./fixtures.js";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "../../packages/web/node_modules/vite/dist/node/index.js";

let server: ViteDevServer;
let origin: string;
test.beforeAll(async () => {
  server = await createServer({ root: fileURLToPath(new URL("../../packages/web", import.meta.url)), logLevel: "silent", server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  const address = server.httpServer!.address();
  if (!address || typeof address === "string") throw new Error("Missing Vite address");
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await server?.close(); });

for (const theme of ["light", "dark"]) for (const width of [390, 1280]) {
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
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
}
