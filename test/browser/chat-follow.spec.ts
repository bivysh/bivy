// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, themes, type WebApp } from "./fixtures.js";
import { fileURLToPath } from "node:url";

let server: WebApp;
let origin: string;
test.beforeAll(async ({ webApp }) => {
  server = webApp;
  origin = webApp.origin;
});

for (const theme of themes) {
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
        // Alternating prompts and answers: every entry is one row of the history window.
        const message = (i) => ({ id: 'entry-' + i, role: i % 2 ? 'assistant' : 'user', text: ('Message ' + i + ' — reading history. ').repeat(30) });
        const render = () => root.render(h(ChatView, { entries: [...entries], working: true, workingLabel: 'Working', draftRoute: false, sessionKey: 'session' }));
        window.load = () => {
          entries = Array.from({length: 40}, (_, i) => message(i));
          // One turn holds interim prose and a tool call: its work counts as one row.
          entries[30] = { id: 'tool-entry', role: 'tool', text: '', tool: { callId: 'read-1', name: 'read', input: {path: 'README.md'}, status: 'done', result: 'File contents\\n'.repeat(200) } };
          render();
        };
        window.replace = (count) => { entries = Array.from({length: count}, (_, i) => message(i)); render(); };
        window.append = () => { entries.push(message(entries.length)); render(); };
        window.replaceWithWorkTurn = () => {
          const read = (n) => ({ id: 'late-tool-' + n, role: 'tool', text: '', tool: { callId: 'late-' + n, name: 'read', input: {path: 'file-' + n + '.md'}, status: 'done', result: 'ok' } });
          entries = [...Array.from({length: 12}, (_, i) => message(i)), { id: 'late-prompt', role: 'user', text: 'Last prompt' },
            ...Array.from({length: 8}, (_, n) => [{ id: 'late-note-' + n, role: 'assistant', text: ('Interim note ' + n + '. ').repeat(20) }, read(n)]).flat(),
            { id: 'late-answer', role: 'assistant', text: 'Final answer.' }];
          render();
        };
        window.updateTool = () => { entries[30] = { ...entries[30], tool: { ...entries[30].tool, result: entries[30].tool.result + 'Updated output' } }; render(); };
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
    await page.locator('.turn-work-line').click();
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

    // Opening a turn's work while following the bottom opens it downward: the
    // line stays where it was and the view is not dragged to the new bottom.
    await page.evaluate(() => (window as unknown as { replaceWithWorkTurn(): void }).replaceWithWorkTurn());
    await chat.evaluate(el => { el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll')); });
    await expect.poll(bottomGap).toBeLessThan(2);
    const workLine = page.locator('.turn-work-line').last();
    const lineBefore = (await workLine.boundingBox())?.y;
    const scrollBefore = await chat.evaluate(el => el.scrollTop);
    await workLine.click();
    await expect(page.locator('.turn-work-body')).toBeVisible();
    expect((await workLine.boundingBox())?.y).toBe(lineBefore);
    expect(await chat.evaluate(el => el.scrollTop)).toBe(scrollBefore);
    await workLine.click();
    await chat.evaluate(el => { el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll')); });

    // A long cached/live transcript can be replaced by a shorter canonical
    // snapshot. The old cutoff must never hide the entire refreshed history.
    const replace = (count: number) => page.evaluate(count =>
      (window as unknown as { replace(count: number): void }).replace(count), count);
    await replace(20);
    await expect(page.locator('.msg')).toHaveCount(20);
    await expect(page.locator('.msg').last()).toContainText('Message 19');
    await expect(page.getByRole('button', { name: /Show earlier messages/ })).toHaveCount(0);
    await expect.poll(bottomGap).toBeLessThan(2);
    await page.evaluate(() => (window as unknown as { append(): void }).append());
    await expect(page.locator('.msg')).toHaveCount(21);
    await expect(page.locator('.msg').first()).toContainText('Message 0');
    await replace(0);
    await expect(page.getByText('No messages yet')).toBeVisible();
    // Persist the empty viewport before reloading. Native scroll delivery can
    // lag behind React's commit, leaving the previous 21-message window saved.
    await chat.evaluate(el => el.dispatchEvent(new Event('scroll', { bubbles: true })));
    await replace(184);
    await expect(page.locator('.msg')).toHaveCount(20);
    await expect(page.getByRole('button', { name: /Show earlier messages \(164 more\)/ })).toBeAttached();
    await replace(164);
    await expect(page.locator('.msg')).toHaveCount(20);
    await expect(page.locator('.msg').last()).toContainText('Message 163');
    await expect.poll(bottomGap).toBeLessThan(2);
    await page.screenshot({ path: testInfo.outputPath(`chat-refreshed-${theme}.png`) });
    await chat.evaluate(el => { el.scrollTop = 0; });
    await page.getByRole('button', { name: /Show earlier messages/ }).click();
    await expect(page.locator('.msg')).toHaveCount(60);
    await replace(5);
    await expect(page.locator('.msg')).toHaveCount(5);
    await expect(page.locator('.msg').last()).toContainText('Message 4');
  });
}
