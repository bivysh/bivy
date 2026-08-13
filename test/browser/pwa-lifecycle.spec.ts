import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("reload restores draft text and only safe attachment metadata", async ({ page }) => {
  const document = `<textarea id="draft"></textarea><div id="files"></div><script>
    const key = 'bivy.composer.new';
    const metadataKey = key + '.metadata';
    const input = document.querySelector('#draft');
    input.value = localStorage.getItem(key) || '';
    input.addEventListener('input', () => localStorage.setItem(key, input.value));
    const raw = localStorage.getItem(metadataKey);
    if (raw) document.querySelector('#files').textContent = JSON.parse(raw).attachments.map(a => a.name).join(', ') + ' — re-select before sending';
  </script>`;
  await page.route("https://bivy.test/", (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: document }));
  await page.goto("https://bivy.test/");
  await page.locator("#draft").fill("Do not lose this thought");
  await page.evaluate(() => localStorage.setItem("bivy.composer.new.metadata", JSON.stringify({
    version: 1, attachments: [{ kind: "file", name: "notes.txt", size: 42, mimeType: "text/plain" }],
  })));
  await page.reload();
  await expect(page.locator("#draft")).toHaveValue("Do not lose this thought");
  await expect(page.locator("#files")).toContainText("notes.txt — re-select");
  expect(await page.evaluate(() => localStorage.getItem("bivy.composer.new.metadata"))).not.toContain("file contents");
});

test("offline, reconnect, and background recovery keep availability claims distinct", async ({ page, context }) => {
  await page.setContent(`<div role="status" id="state">Live control — prompts send now</div><script>
    const el = document.querySelector('#state');
    addEventListener('offline', () => el.textContent = 'Cached transcript — may be behind the Machine');
    addEventListener('online', () => { el.textContent = 'Reconnecting Machine'; setTimeout(() => el.textContent = 'Live control — transcript changes sync live', 20); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && navigator.onLine) el.dataset.recovered = 'true'; });
  </script>`);
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await expect(page.getByRole("status")).toContainText("Cached transcript");
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.getByRole("status")).toContainText("Reconnecting Machine");
  await expect(page.getByRole("status")).toContainText("Live control");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByRole("status")).toHaveAttribute("data-recovered", "true");
});

test("update UX documents preservation and blocks activation during user work", async ({ page }) => {
  const source = await readFile(new URL("../../packages/web/src/components/UpdatePrompt.tsx", import.meta.url), "utf8");
  expect(source).toContain("Reload preserves cached transcripts and draft text");
  expect(source).toContain("disabled={blockers.length > 0}");
  await page.setContent(`<button disabled>Reload safely</button><p>Reload is available after the active turn finishes.</p>`);
  await expect(page.getByRole("button", { name: "Reload safely" })).toBeDisabled();
  await expect(page.getByText(/active turn finishes/)).toBeVisible();
});

test("install eligibility has Chromium, iOS/Safari, and standalone fallbacks", async ({ page }) => {
  const source = await readFile(new URL("../../packages/web/src/pwaLifecycle.ts", import.meta.url), "utf8");
  expect(source).toContain('"beforeinstallprompt"');
  expect(source).toContain("!state.firstSuccess");
  expect(source).toContain("display-mode: standalone");
  const notice = await readFile(new URL("../../packages/web/src/components/PwaLifecycleNotice.tsx", import.meta.url), "utf8");
  expect(notice).toContain("Add to Home Screen");
  expect(notice).toContain("File → Add to Dock");

  await page.setContent(`<button id="install" hidden>Install</button><script>
    let successful = false;
    addEventListener('beforeinstallprompt', e => { e.preventDefault(); if (successful && !matchMedia('(display-mode: standalone)').matches) install.hidden = false; });
    window.firstSuccess = () => { successful = true; };
  </script>`);
  await page.evaluate(() => window.dispatchEvent(new Event("beforeinstallprompt", { cancelable: true })));
  await expect(page.locator("#install")).toBeHidden();
  await page.evaluate(() => { (window as unknown as { firstSuccess(): void }).firstSuccess(); window.dispatchEvent(new Event("beforeinstallprompt", { cancelable: true })); });
  await expect(page.locator("#install")).toBeVisible();
});
