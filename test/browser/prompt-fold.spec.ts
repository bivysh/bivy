// SPDX-License-Identifier: MIT
import { expect, test } from "./fixtures.js";
import { fileURLToPath } from "node:url";

// A long sent message folds to ten lines behind "Show full"; a short one doesn't.
test("a long sent message folds behind Show full and expands", async ({ page, webApp }) => {
  const html = await webApp.transformIndexHtml("/fold-test", `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root" style="height:100dvh;display:flex;flex-direction:column"></div>
    <script type="module">
      import { createElement as h } from 'react';
      import { createRoot } from 'react-dom/client';
      import '/@fs/${fileURLToPath(new URL("../../packages/ui/tokens.css", import.meta.url))}';
      import '/src/styles.css';
      import { ChatView } from '/src/components/ChatView.tsx';
      const log = Array.from({ length: 30 }, (_, i) => 'log line ' + i).join('\\n');
      const entries = [{ id: 'short', role: 'user', text: 'Short prompt' }, { id: 'long', role: 'user', text: log }];
      createRoot(document.getElementById('root')).render(h(ChatView, { entries, working: false, draftRoute: false, sessionKey: 'session' }));
    </script></body></html>`);
  await page.route(`${webApp.origin}/fold-test`, route => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto(`${webApp.origin}/fold-test`);
  const toggle = page.getByRole("button", { name: "Show full" });
  await expect(toggle).toHaveCount(1);
  const folded = await page.locator("#prompt-long").evaluate(el => el.clientHeight);
  await toggle.click();
  await expect(page.getByRole("button", { name: "Show less" })).toHaveAttribute("aria-expanded", "true");
  expect(await page.locator("#prompt-long").evaluate(el => el.clientHeight)).toBeGreaterThan(folded * 2);
});
