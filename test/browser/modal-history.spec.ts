// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from "./fixtures.js";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type ViteDevServer } from "../../packages/web/node_modules/vite/dist/node/index.js";

type FixtureWindow = Window & { pops: string[]; removeOverlays(): void; replaceAfterConfirm?: boolean };

let server: ViteDevServer;
let origin: string;
let cacheDir: string;

test.beforeAll(async () => {
  const root = path.resolve("packages/web");
  cacheDir = await mkdtemp(path.join(root, "node_modules/.vite-modal-history-"));
  server = await createServer({ root, cacheDir, logLevel: "silent", server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  const address = server.httpServer!.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => {
  await server?.close();
  if (cacheDir) await rm(cacheDir, { recursive: true, force: true });
});

async function openFixture(page: Page, theme = "light") {
  // Observe raw traversals before the modal coordinator consumes them. Route
  // listeners installed by the app must not receive these sentinel pops.
  await page.addInitScript(() => {
    window.addEventListener("popstate", () => (window as FixtureWindow).pops?.push(location.pathname));
  });
  const html = await server.transformIndexHtml("/modal-history-test", `<html data-theme="${theme}"><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module">
    import React, { StrictMode, useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { ConfirmDialog } from '/src/components/AppDialog.tsx';
    import { Sheet } from '/src/components/Sheet.tsx';
    import '/@fs/${path.resolve("packages/ui/tokens.css")}';
    import '/src/styles.css';
    // Reproduce signing in before opening the picker. An extra Back lands on
    // this OAuth entry; no live account or GitHub authorization is needed.
    history.replaceState({}, '', '/auth/github/start');
    history.pushState({}, '', '/sessions/new');
    window.pops = [];
    function App() {
      const [open, setOpen] = useState(false);
      const [confirming, setConfirming] = useState(false);
      const [selected, setSelected] = useState('Pi');
      const [replacement, setReplacement] = useState(false);
      window.removeOverlays = () => { setConfirming(false); setOpen(false); };
      return React.createElement(React.Fragment, null,
        React.createElement('p', { role: 'status' }, 'Selected: ' + selected),
        React.createElement('button', { onClick: () => setOpen(true) }, 'Choose agent'),
        replacement && React.createElement(Sheet, { title: 'Model', ariaLabel: 'Model', onClose: () => setReplacement(false) }, 'Choose a model'),
        open && React.createElement(Sheet, { title: 'Agent', ariaLabel: 'Agent', onClose: () => setOpen(false) },
          React.createElement('button', { className: 'btn', onClick: () => setConfirming(true) }, 'Claude Code'),
          confirming && React.createElement(ConfirmDialog, {
            title: 'Check how Claude Code runs', message: 'Confirm this agent choice.', confirmLabel: 'Use Claude Code',
            onCancel: () => setConfirming(false),
            // Same lifecycle as AgentPicker: request the dialog's Back, then
            // synchronously unmount both the picker and its confirmation.
            onConfirm: () => { setSelected('Claude Code'); setConfirming(false); setOpen(false); setReplacement(Boolean(window.replaceAfterConfirm)); },
          }),
        ),
      );
    }
    createRoot(document.getElementById('root')).render(React.createElement(StrictMode, null, React.createElement(App)));
  </script></body></html>`);
  await page.route(`${origin}/modal-history-test`, (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto(`${origin}/modal-history-test`);
  await page.getByRole("button", { name: "Choose agent" }).click();
  await expect(page.getByRole("dialog", { name: "Agent", exact: true })).toBeVisible();
  // StrictMode must leave exactly one sentinel, without a spurious Back.
  await expect.poll(() => page.evaluate(() => history.length)).toBe(4);
  await expect.poll(() => page.evaluate(() => (window as FixtureWindow).pops.length)).toBe(0);
}

async function openConfirmation(page: Page) {
  await page.getByRole("button", { name: "Claude Code", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Check how Claude Code runs" })).toBeVisible();
}

async function expectStillInApp(page: Page, pops: number) {
  await expect.poll(() => page.evaluate(() => (window as FixtureWindow).pops.length)).toBe(pops);
  // Allow any accidentally queued extra traversal to arrive as well.
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as FixtureWindow).pops)).toEqual(Array(pops).fill("/sessions/new"));
  await expect(page).toHaveURL(`${origin}/sessions/new`);
}

for (const theme of ["light", "dark"]) {
  test(`confirming an agent consumes each nested sentinel only once (${theme})`, async ({ page }, testInfo) => {
    await openFixture(page, theme);
    await openConfirmation(page);
    await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath(`agent-confirm-${theme}.png`) });
    await page.getByRole("button", { name: "Use Claude Code", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("status")).toHaveText("Selected: Claude Code");
    await expectStillInApp(page, 2);
    // There must be no stale overlay entries left over either.
    await page.evaluate(() => history.back());
    await expect(page).toHaveURL(`${origin}/auth/github/start`);
  });
}

for (const dismiss of ["back", "escape", "cancel"]) {
  test(`${dismiss} dismisses only the topmost overlay`, async ({ page }) => {
    await openFixture(page);
    await openConfirmation(page);
    if (dismiss === "back") await page.evaluate(() => history.back());
    else if (dismiss === "escape") await page.keyboard.press("Escape");
    else await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Check how Claude Code runs" })).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "Agent", exact: true })).toBeVisible();
    await expectStillInApp(page, 1);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expectStillInApp(page, 2);
  });
}

test("unmounting nested overlays drains their sentinels without navigating away", async ({ page }) => {
  await openFixture(page);
  await openConfirmation(page);
  await page.evaluate(() => (window as FixtureWindow).removeOverlays());
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expectStillInApp(page, 2);
});

test("repeated close requests before popstate do not queue extra Back traversals", async ({ page }) => {
  await openFixture(page);
  await openConfirmation(page);
  await page.getByRole("button", { name: "Cancel", exact: true }).evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect(page.getByRole("dialog", { name: "Agent", exact: true })).toBeVisible();
  await expectStillInApp(page, 1);
});

test("a replacement overlay waits for old sentinels to drain", async ({ page }) => {
  await openFixture(page);
  await openConfirmation(page);
  await page.evaluate(() => { (window as FixtureWindow).replaceAfterConfirm = true; });
  await page.getByRole("button", { name: "Use Claude Code", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Model", exact: true })).toBeVisible();
  await expectStillInApp(page, 2);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expectStillInApp(page, 3);
  await page.evaluate(() => history.back());
  await expect(page).toHaveURL(`${origin}/auth/github/start`);
});
