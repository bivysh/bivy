import { expect, test } from "@playwright/test";
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

test("actual availability model journeys through offline, reconnect, queue, and live states", async ({ page }) => {
  await openModuleFixture(page, `<div role="status" id="state"></div><script type="module">
    import { describeAvailability } from '/src/pwaLifecycle.ts';
    const base = { updateAvailable: false, installChoice: null, standalone: false, shellCached: true, firstSuccess: true, hasDraft: false, pendingAttachments: 0, readingAttachments: false, turnActive: false, locallyQueuedPrompts: 0 };
    window.renderAvailability = (status, transcript, patch = {}) => {
      const message = describeAvailability(status, transcript, { ...base, ...patch });
      state.dataset.kind = message.kind;
      state.textContent = message.label + ' — ' + message.detail;
    };
    window.renderAvailability('offline', false);
  </script>`);
  const render = (status: string, transcript: boolean, patch = {}) => page.evaluate(
    ([nextStatus, cached, nextPatch]) => (window as unknown as { renderAvailability(s: string, c: boolean, p: object): void }).renderAvailability(nextStatus, cached, nextPatch),
    [status, transcript, patch] as const,
  );

  await expect(page.getByRole("status")).toHaveAttribute("data-kind", "cached-shell");
  await render("offline", true);
  await expect(page.getByRole("status")).toHaveAttribute("data-kind", "cached-transcript");
  await render("reconnecting", true);
  await expect(page.getByRole("status")).toContainText("Reconnecting Machine");
  await render("reconnecting", true, { locallyQueuedPrompts: 1 });
  await expect(page.getByRole("status")).toContainText("Prompt queued on this device");
  await render("online", true);
  await expect(page.getByRole("status")).toContainText("Live control");
});

test("background return triggers the wired recovery journey", async ({ page }) => {
  const controller = await readFile(new URL("../../packages/web/src/store/controller.ts", import.meta.url), "utf8");
  expect(controller).toContain("visibilityState === \"visible\"");
  expect(controller).toContain("this.refreshAfterForeground()");
  expect(controller).toContain('window.addEventListener("pageshow", onForeground)');

  await page.setContent(`<div role="status">Backgrounded</div><script>
    let recoveries = 0;
    const recover = () => { recoveries += 1; document.querySelector('[role=status]').textContent = 'Live control recovered ' + recoveries; };
    document.addEventListener('visibilitychange', recover);
    window.addEventListener('pageshow', recover);
  </script>`);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByRole("status")).toContainText("Live control recovered");
});

test("update activation model blocks every disruptive state before reload", async ({ page }) => {
  const pwa = await readFile(new URL("../../packages/web/src/pwa.ts", import.meta.url), "utf8");
  expect(pwa).toContain("if (!canActivateUpdate()) return false");
  await openModuleFixture(page, `<button id="reload">Reload safely</button><p role="status"></p><script type="module">
    import { canActivateUpdate, updateBlockers } from '/src/pwaLifecycle.ts';
    const base = { updateAvailable: true, installChoice: null, standalone: false, shellCached: true, firstSuccess: true, hasDraft: false, pendingAttachments: 0, readingAttachments: false, turnActive: false, locallyQueuedPrompts: 0 };
    window.setWork = patch => {
      const state = { ...base, ...patch };
      reload.disabled = !canActivateUpdate(state);
      document.querySelector('[role=status]').textContent = updateBlockers(state).join(', ') || 'Draft text and attachment names are stored in this browser.';
    };
    window.setWork({ turnActive: true, readingAttachments: true, hasDraft: true, pendingAttachments: 1, locallyQueuedPrompts: 1 });
  </script>`);
  await expect(page.getByRole("button", { name: "Reload safely" })).toBeDisabled();
  await expect(page.getByRole("status")).toContainText("active turn finishes");
  await expect(page.getByRole("status")).toContainText("locally queued prompts reach the Machine");
  await page.evaluate(() => (window as unknown as { setWork(p: object): void }).setWork({}));
  await expect(page.getByRole("button", { name: "Reload safely" })).toBeEnabled();
  await expect(page.getByRole("status")).toContainText("Draft text and attachment names");
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
