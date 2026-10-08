// SPDX-License-Identifier: AGPL-3.0-only
//
// Components an agent placed inside its message, rendered by the real ChatView
// with the real stylesheet. What this is here to prove cannot be seen from the
// markdown renderer's output alone: the mount points the renderer leaves behind
// actually receive React, the chip is the SAME one the composer produces, and
// the two ways a component can fail to render both say so instead of leaving a
// hole in the message.
import { expect, test, themes, type WebApp } from "./fixtures.js";
import { fileURLToPath } from "node:url";

let server: WebApp;
let origin: string;
test.beforeAll(async ({ webApp }) => {
  server = webApp;
  origin = webApp.origin;
});

// 390 is the phone case the chip width has to survive; 1024 is where a chip
// inside prose must not stretch to the full message column.
for (const theme of themes) for (const width of [390, 1024]) {
  test(`${theme} ${width}: placed components render, and say so when they cannot`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const text = [
      "Here is what I found.",
      "",
      "::view{src=out/report.pdf caption=\"The quarterly summary\"}",
      "",
      "A reference the node has not resolved yet:",
      "",
      "::view{src=out/pending.pdf}",
      "",
      "And a kind this build does not know:",
      "",
      "```bivy",
      '{"type":"sankey","title":"Where the time went"}',
      "```",
      "",
      "That is everything.",
    ].join("\n");
    const html = await server.transformIndexHtml('/component-test', `<!doctype html><html data-theme="${theme}"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root" style="height:100dvh;display:flex;flex-direction:column"></div><script type="module">
      import { createElement as h } from 'react';
      import { createRoot } from 'react-dom/client';
      import '/@fs/${fileURLToPath(new URL('../../packages/ui/tokens.css', import.meta.url))}';
      import '/src/styles.css';
      import { ChatView } from '/src/components/ChatView.tsx';
      import { controller } from '/src/store/useStore.ts';
      // The resolved chip fetches its bytes by hash from the node. There is no
      // node here, so stand in for that one call — everything else under test
      // (kind resolution, the registry, the portal, the layout) is real.
      controller.fetchAttachment = async (hash) => hash === 'resolved-hash'
        ? { data: btoa('quarter,total\\nQ1,12'), mimeType: 'application/pdf' }
        : null;
      createRoot(document.getElementById('root')).render(h(ChatView, {
        entries: [{
          id: 'reply', role: 'assistant', text: ${JSON.stringify(text)},
          imageRefs: { 'out/report.pdf': { hash: 'resolved-hash', name: 'report.pdf', mimeType: 'application/pdf', size: 20, kind: 'file' } },
        }],
        working: false, draftRoute: false, sessionKey: 'test',
      }));
      </script></body></html>`);
    await page.route(`${origin}/component-test`, route => route.fulfill({ contentType: 'text/html', body: html }));
    await page.goto(`${origin}/component-test`);

    // The prose around the components is untouched, and the components sit
    // between the paragraphs rather than being hoisted above them.
    await expect(page.getByText('Here is what I found.')).toBeVisible();
    await expect(page.getByText('That is everything.')).toBeVisible();

    // A resolved reference renders the ordinary attachment chip, caption and
    // all, with a download that works.
    const chip = page.locator('.md-component .msg-attachment').first();
    await expect(chip).toBeVisible();
    await expect(chip.getByText('report.pdf')).toBeVisible();
    await expect(chip.getByText('The quarterly summary')).toBeVisible();
    const download = page.getByRole('link', { name: 'Download report.pdf' });
    const started = page.waitForEvent('download');
    await download.click();
    expect((await started).suggestedFilename()).toBe('report.pdf');

    // Both failure modes name what the agent meant. Neither is silent, and
    // neither is styled as the reader's error.
    await expect(page.getByText('out/pending.pdf')).toBeVisible();
    await expect(page.getByText(/still being prepared/)).toBeVisible();
    await expect(page.getByText('Where the time went')).toBeVisible();
    await expect(page.getByText(/cannot show a “sankey” yet/)).toBeVisible();

    // Every placed component fills the same reading column, so a chip and a
    // fallback card line up with each other and with the prose.
    const box = (await chip.boundingBox())!;
    const fallback = (await page.locator('.md-component .card').first().boundingBox())!;
    expect(box.x).toBeCloseTo(fallback.x, 0);
    expect(box.width).toBeCloseTo(fallback.width, 0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);

    // Document order: the components are where the agent wrote them.
    const order = await page.locator('.msg.assistant > *').evaluateAll(
      (nodes) => nodes.map((n) => (n.className || n.tagName).toString()),
    );
    expect(order.filter((c) => c.includes('md-component'))).toHaveLength(3);
    expect(order[0]).toBe('P');

    await page.screenshot({ path: testInfo.outputPath('components.png'), fullPage: true });
  });
}
