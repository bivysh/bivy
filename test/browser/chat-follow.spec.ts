// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "./fixtures.js";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "../../packages/web/node_modules/vite/dist/node/index.js";

let server: ViteDevServer;
let origin: string;
test.beforeAll(async () => {
  server = await createServer({
    root: fileURLToPath(new URL("../../packages/web", import.meta.url)),
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  const address = server.httpServer!.address();
  if (!address || typeof address === "string") throw new Error("Missing Vite address");
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await server?.close(); });

for (const theme of ["light", "dark"]) {
  test(`${theme}: streaming preserves reading position and tool inspection`, async ({ page }, testInfo) => {
    const html = await server.transformIndexHtml('/chat-test', `<!doctype html><html data-theme="${theme}"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root" style="height:100dvh;display:flex;flex-direction:column"></div>
      <script type="module">
        import { createElement as h } from 'react';
        import { createRoot } from 'react-dom/client';
        import '/@fs/${fileURLToPath(new URL('../../packages/ui/tokens.css', import.meta.url))}';
        import '/src/styles.css';
        import { ChatView } from '/src/components/ChatView.tsx';
        const root = createRoot(document.getElementById('root'));
        let entries = [];
        const message = (i) => ({ id: 'entry-' + i, role: 'assistant', text: ('Message ' + i + ' — reading history. ').repeat(30) });
        const render = () => root.render(h(ChatView, { entries: [...entries], working: true, workingLabel: 'Working', draftRoute: false, sessionKey: 'session' }));
        window.load = () => {
          entries = Array.from({length: 40}, (_, i) => message(i));
          entries[20] = { id: 'tool-entry', role: 'tool', text: '', tool: { callId: 'read-1', name: 'read', input: {path: 'README.md'}, status: 'done', result: 'File contents\\n'.repeat(200) } };
          render();
        };
        window.append = () => { entries.push(message(entries.length)); render(); };
        window.updateTool = () => { entries[20] = { ...entries[20], tool: { ...entries[20].tool, result: entries[20].tool.result + 'Updated output' } }; render(); };
        window.stream = () => { entries[entries.length - 1] = { ...entries.at(-1), text: entries.at(-1).text + ' More streamed text.'.repeat(50), streaming: true }; render(); };
        render();
      </script></body></html>`);
    await page.route(`${origin}/chat-test`, route => route.fulfill({ contentType: 'text/html', body: html }));
    await page.goto(`${origin}/chat-test`);
    await expect(page.getByText('No messages yet')).toBeVisible();
    await page.evaluate(() => (window as unknown as { load(): void }).load());
    const chat = page.locator('.chat');
    const bottomGap = () => chat.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight);
    await expect(page.getByRole('button', { name: /Show earlier messages \(20 more\)/ })).toBeAttached();
    await expect.poll(bottomGap).toBeLessThan(2);
    await page.evaluate(() => (window as unknown as { append(): void }).append());
    await expect.poll(bottomGap).toBeLessThan(2);
    await chat.evaluate(el => { el.scrollTop = 0; });
    await expect(page.getByRole('button', { name: 'Jump to latest' })).toBeVisible();
    const opener = page.getByRole('button', { name: /Open work details/ });
    await expect(opener).toBeVisible();
    const before = await chat.evaluate(el => el.scrollTop);
    const bounds = await opener.boundingBox();
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => (window as unknown as { append(): void }).append());
      await expect(page.locator('.msg').last()).toContainText(`Message ${41 + i}`);
      expect(await chat.evaluate(el => el.scrollTop)).toBe(before);
      expect((await opener.boundingBox())?.y).toBe(bounds?.y);
    }
    await opener.click();
    await page.locator('.activity-row').click();
    await expect(page.locator('.activity-detail')).toContainText('File contents');
    const output = page.locator('.activity-detail .output');
    await output.evaluate(el => { el.scrollTop = 120; });
    const inspectionTop = await output.evaluate(el => el.scrollTop);
    expect(inspectionTop).toBeGreaterThan(0);
    await page.evaluate(() => (window as unknown as { append(): void }).append());
    await page.evaluate(() => (window as unknown as { stream(): void }).stream());
    await expect(page.locator('.msg').last()).toContainText('More streamed text.');
    await page.evaluate(() => (window as unknown as { updateTool(): void }).updateTool());
    await expect(page.locator('.activity-detail')).toBeVisible();
    await expect(output).toContainText('Updated output');
    expect(await output.evaluate(el => el.scrollTop)).toBe(inspectionTop);
    expect(await chat.evaluate(el => el.scrollTop)).toBe(before);
    await page.screenshot({ path: testInfo.outputPath(`chat-inspection-${theme}.png`) });
    await page.keyboard.press('Escape');
    await expect(opener).toBeFocused();
    await page.getByRole('button', { name: 'Jump to latest' }).click();
    await expect.poll(bottomGap).toBeLessThan(2);
    await page.evaluate(() => (window as unknown as { stream(): void }).stream());
    await expect.poll(bottomGap).toBeLessThan(2);
  });
}
