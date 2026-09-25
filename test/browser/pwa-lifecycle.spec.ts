import { expect, test } from "./fixtures.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Vite is a @bivy/web devDependency, not a root dependency.
import { createServer, type ViteDevServer } from "../../packages/web/node_modules/vite/dist/node/index.js";

let server: ViteDevServer;
let origin: string;

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../packages/web");

test.beforeAll(async () => {
  server = await createServer({ root: webRoot, logLevel: "silent", server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("Vite test server did not bind a TCP port");
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => { await server.close(); });

async function openModuleFixture(page: import("@playwright/test").Page, body: string): Promise<void> {
  await page.route(`${origin}/pwa-test`, (route) => route.fulfill({
    contentType: "text/html; charset=utf-8",
    body,
  }));
  await page.goto(`${origin}/pwa-test`);
}

test("reload restores a real composer snapshot and only safe attachment metadata", async ({ page }) => {
  await openModuleFixture(page, `<textarea id="draft"></textarea><div id="files"></div><script type="module">
    import { readComposerDraft, writeComposerDraft } from '/src/composerDraft.ts';
    const input = document.querySelector('#draft');
    const render = () => {
      const saved = readComposerDraft(localStorage, null);
      input.value = saved.text;
      document.querySelector('#files').textContent = saved.attachments.map(a => a.name).join(', ') + (saved.attachments.length ? ' — re-select before sending' : '');
    };
    render();
    input.addEventListener('input', () => writeComposerDraft(localStorage, null, input.value, []));
    window.saveAttachment = () => writeComposerDraft(localStorage, null, input.value, [{ kind: 'file', name: 'notes.txt', size: 42, mimeType: 'text/plain', text: 'file contents' }]);
  </script>`);
  await page.locator("#draft").fill("Do not lose this thought");
  await page.evaluate(() => (window as unknown as { saveAttachment(): void }).saveAttachment());
  await page.reload();
  await expect(page.locator("#draft")).toHaveValue("Do not lose this thought");
  await expect(page.locator("#files")).toContainText("notes.txt — re-select");
  const stored = await page.evaluate(() => Object.values(localStorage).join("\n"));
  expect(stored).not.toContain("file contents");
});

// Availability labels and update-blocker permutations are pure functions covered
// by test/pwa-lifecycle.test.ts. Keep browser storage/reload and install events here.
