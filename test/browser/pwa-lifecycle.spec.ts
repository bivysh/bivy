import { expect, test } from "./fixtures.js";
import { readFile } from "node:fs/promises";
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

test("install suggestion is compact, out of the composer flow, and permanently dismissible", async ({ page }) => {
  await openModuleFixture(page, `<button id="dismiss" hidden>Dismiss install suggestion</button><script type="module">
    import { dismissInstall, getPwaLifecycleState, initializeInstallLifecycle, markFirstSuccessfulResponse, subscribePwaLifecycle } from '/src/pwaLifecycle.ts';
    const button = document.querySelector('#dismiss');
    const render = () => { button.hidden = getPwaLifecycleState().installChoice === null; };
    subscribePwaLifecycle(render);
    initializeInstallLifecycle();
    const offer = new Event('beforeinstallprompt', { cancelable: true });
    offer.prompt = async () => {};
    offer.userChoice = Promise.resolve({ outcome: 'dismissed', platform: 'web' });
    dispatchEvent(offer);
    markFirstSuccessfulResponse();
    button.addEventListener('click', dismissInstall);
    window.offerInstallAgain = () => dispatchEvent(offer);
    window.installChoice = () => getPwaLifecycleState().installChoice;
  </script>`);

  const dismiss = page.getByRole("button", { name: "Dismiss install suggestion" });
  await expect(dismiss).toBeVisible();
  await dismiss.click();
  await expect(dismiss).toBeHidden();
  await page.evaluate(() => (window as unknown as { offerInstallAgain(): void }).offerInstallAgain());
  expect(await page.evaluate(() => (window as unknown as { installChoice(): unknown }).installChoice())).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem("bivy.pwa.install-dismissed"))).toBe("1");

  const [notice, styles] = await Promise.all([
    readFile(new URL("../../packages/web/src/components/PwaLifecycleNotice.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../packages/web/src/pwa-lifecycle.css", import.meta.url), "utf8"),
  ]);
  expect(notice).toContain('aria-label="Dismiss install suggestion"');
  expect(styles).toMatch(/\.pwa-install\s*{[^}]*position: fixed;/s);
  expect(styles).toContain("width: min(360px, calc(100vw - 32px))");
});

test("install is contextual after success with native, iOS/Safari, and standalone fallbacks", async ({ page }) => {
  await openModuleFixture(page, `<button id="install" hidden>Install Bivy</button><output></output><script type="module">
    import { fallbackInstallChoice, getPwaLifecycleState, initializeInstallLifecycle, markFirstSuccessfulResponse, requestInstall, subscribePwaLifecycle } from '/src/pwaLifecycle.ts';
    const installButton = document.querySelector('#install');
    const result = document.querySelector('output');
    const render = () => { installButton.hidden = getPwaLifecycleState().installChoice !== 'native'; };
    subscribePwaLifecycle(render);
    initializeInstallLifecycle();
    let prompted = 0;
    const event = new Event('beforeinstallprompt', { cancelable: true });
    event.prompt = async () => { prompted += 1; };
    event.userChoice = Promise.resolve({ outcome: 'accepted', platform: 'web' });
    dispatchEvent(event);
    render();
    const request = async () => { result.textContent = (await requestInstall()) + ':' + prompted; };
    installButton.addEventListener('click', request);
    window.installTest = {
      success: markFirstSuccessfulResponse,
      fallbacks: () => [
        fallbackInstallChoice('Mozilla/5.0 (iPhone) Safari', 'iPhone', 5),
        fallbackInstallChoice('Mozilla/5.0 Version/17.4 Safari/605.1', 'MacIntel', 0),
        fallbackInstallChoice('Mozilla/5.0 (iPhone) Safari', 'iPhone', 5, true),
      ],
    };
  </script>`);
  await expect(page.getByRole("button", { name: "Install Bivy" })).toBeHidden();
  await page.evaluate(() => (window as unknown as { installTest: { success(): void } }).installTest.success());
  await expect(page.getByRole("button", { name: "Install Bivy" })).toBeVisible();
  await page.getByRole("button", { name: "Install Bivy" }).click();
  await expect(page.locator("output")).toHaveText("accepted:1");
  expect(await page.evaluate(() => (window as unknown as { installTest: { fallbacks(): unknown[] } }).installTest.fallbacks())).toEqual(["ios", "safari", null]);

  const notice = await readFile(new URL("../../packages/web/src/components/PwaLifecycleNotice.tsx", import.meta.url), "utf8");
  expect(notice).toContain("Add to Home Screen");
  expect(notice).toContain("Safari 17 or later");
  expect(notice).toContain("cannot install Bivy as a web app");
});
