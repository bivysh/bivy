// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, themes } from "./fixtures.js";
import path from "node:path";

// On a wide screen the session's changes, apps and artifacts dock in a pane
// beside the chat. This mounts the real SidePane with the real docked bodies
// (the same components that are sheets on a phone) in the app's real grid, and
// checks it is a column of the layout, not a modal over it.
for (const theme of themes) {
  test(`side pane docks beside the chat (${theme})`, async ({ page, webApp }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.setViewportSize({ width: 1440, height: 900 });
    const html = await webApp.transformIndexHtml("/side-pane", `<html data-theme="${theme}"><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module">
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { SidePane } from '/src/components/SidePane.tsx';
      import { SessionChangesSheet } from '/src/components/SessionChangesSheet.tsx';
      import { ArtifactsSheet } from '/src/components/ArtifactsSheet.tsx';
      import { AppsSheet } from '/src/components/AppsSheet.tsx';
      import { TerminalOverlay } from '/src/components/Terminal.tsx';
      import { controller } from '/src/store/controller.ts';
      import '/@fs/${path.resolve("packages/ui/tokens.css")}';
      import '/src/styles.css';
      import '/src/ux-cleanup.css';
      const h = React.createElement;
      controller.store.setStatus('online');
      const app = { id: 'a', sessionId: 's', name: 'Invoice editor', createdAt: Date.now() - 300000, views: [{ id: 'web', kind: 'web', name: 'Website', source: 'service' }] };
      controller.appCommand = async (kind) => {
        if (kind === 'apps.offers') return { offers: [] };
        if (kind === 'apps.list') return { apps: [app], previewAvailable: true };
        if (kind === 'apps.open') return { kind: 'web', url: 'https://pane.preview.example.net/__bivy/open#ticket' };
        return { ok: true };
      };
      // The shell runs on the machine; record what the pane asks it for.
      window.terminalCommands = [];
      const terminalListeners = new Set();
      controller.onTerminal = (fn) => { terminalListeners.add(fn); return () => terminalListeners.delete(fn); };
      controller.sendTerminal = (command) => {
        window.terminalCommands.push(command);
        if (command.kind === 'terminal.open') setTimeout(() => terminalListeners.forEach((fn) => fn({ type: 'terminal.opened', termId: 'shell-1', workspace: '/work/bivy' })), 20);
      };
      const lines = (n, word) => Array.from({ length: n }, (_, i) => word + i).join('\\n');
      const file = (p, a, b) => ({ path: p, status: 'modified', oldText: lines(a, 'old '), newText: lines(b, 'new ') });
      const history = Array.from({ length: 6 }, (_, i) => ({
        id: 't' + i, at: Date.now() - (6 - i) * 600000,
        files: [file('packages/web/src/components/SidePane.tsx', 4, 40), file('packages/web/src/styles.css', 10, 30), file('packages/web/src/App.tsx', 20, 26)],
      }));
      const artifacts = [{ id: 'a1', entryId: 'e1', kind: 'file', name: 'coverage-report.html', size: 48213, mimeType: 'text/html', hash: 'h1', createdAt: Date.now() - 60000, artifact: true }];
      function Shell() {
        const [tab, setTab] = React.useState('changes');
        return h('div', { className: 'app has-pane' },
          h('aside', { className: 'sidebar' }, h('div', { className: 'sidebar-head' }, h('span', { className: 'brand' }, 'Bivy'))),
          h('main', { className: 'main' },
            h('header', { className: 'topbar' },
              h('div', { className: 'topbar-title' },
                h('div', { className: 'topbar-title-row' }, h('h1', { className: 'title' }, 'Side pane for changes')),
                h('div', { className: 'topbar-subline' }, h('span', null, 'Mac Studio')))),
            h('div', { className: 'chat-wrap' }, h('div', { className: 'chat' }, h('div', { className: 'chat-inner' },
              h('div', { className: 'msg user' }, 'Dock the changes beside the chat.'),
              h('div', { className: 'assistant-row' }, h('div', { className: 'msg assistant' }, h('p', null, 'Done. Changes, apps and artifacts now sit in a pane on the right on wide screens.')))))),
            h('section', { className: 'composer' }, h('div', { className: 'composer-card' }, h('textarea', { className: 'composer-input', rows: 1, 'aria-label': 'Message', placeholder: 'Ask a follow-up…' })))),
          tab && h(SidePane, {
            tabs: [{ id: 'changes', label: 'Changes', count: 3 }, { id: 'apps', label: 'Apps' }, { id: 'artifacts', label: 'Artifacts', count: 1 }, { id: 'terminal', label: 'Terminal' }],
            active: tab, onSelect: setTab, onClose: () => setTab(null),
          },
            tab === 'changes' && h(SessionChangesSheet, { docked: true, history, onClose() {} }),
            tab === 'apps' && h(AppsSheet, { docked: true, sessionId: 's', onClose() {} }),
            tab === 'artifacts' && h(ArtifactsSheet, { docked: true, artifacts, onClose() {} }),
            tab === 'terminal' && h(TerminalOverlay, { embedded: true, sessionId: 's', onClose: () => setTab('changes') })));
      }
      createRoot(document.getElementById('root')).render(h(Shell));
    </script></body></html>`);
    await page.route(`${webApp.origin}/side-pane`, (route) => route.fulfill({ contentType: "text/html", body: html }));
    await page.goto(`${webApp.origin}/side-pane`);

    const pane = page.getByRole("complementary", { name: "Session details" });
    await expect(pane).toBeVisible();
    // A column of the layout: right of the chat, full height, nothing modal.
    const main = (await page.locator(".main").boundingBox())!;
    const box = (await pane.boundingBox())!;
    expect(Math.abs(main.x + main.width - box.x)).toBeLessThan(2);
    expect(box.height).toBe(900);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator(".composer")).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    // The pane head lines up with the chat's top bar.
    const head = (await page.locator(".side-pane-head").boundingBox())!;
    const topbar = (await page.locator(".topbar").boundingBox())!;
    expect(Math.abs(head.height - topbar.height)).toBeLessThan(2);

    // A long history scrolls inside the pane, never the page.
    for (const turn of await pane.getByRole("button", { name: /3 files changed/ }).all()) await turn.click();
    const scroller = pane.locator(".pane-panel-content");
    expect(await scroller.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    await scroller.evaluate((el) => { el.scrollTop = 0; });
    await page.screenshot({ path: testInfo.outputPath(`side-pane-changes-${theme}.png`) });

    // Tabs follow the WAI-ARIA pattern: arrows move and select.
    const changes = pane.getByRole("tab", { name: /Changes/ });
    await changes.focus();
    await page.keyboard.press("ArrowRight");
    await expect(pane.getByRole("tab", { name: /Apps/ })).toHaveAttribute("aria-selected", "true");

    // A preview opens in the pane, beside the chat, not over it.
    await page.context().route("https://pane.preview.example.net/**", (route) => route.fulfill({ contentType: "text/html", body: "<h1>Invoice editor</h1>" }));
    await pane.getByRole("button", { name: "Open preview" }).click();
    const preview = pane.locator("iframe.preview-peek");
    await expect(preview).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const frame = (await preview.boundingBox())!;
    expect(frame.x).toBeGreaterThanOrEqual(box.x);
    expect(frame.y + frame.height).toBeLessThanOrEqual(900 + 1);
    await page.screenshot({ path: testInfo.outputPath(`side-pane-preview-${theme}.png`) });

    await pane.getByRole("tab", { name: /Apps/ }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(pane.getByRole("tab", { name: /Artifacts/ })).toHaveAttribute("aria-selected", "true");
    await expect(pane.getByText("coverage-report.html")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`side-pane-artifacts-${theme}.png`) });

    // Terminal: a shell in this session's workspace, in the pane's flow (not
    // the full-screen overlay), and ending it goes back to Changes.
    await page.keyboard.press("ArrowRight");
    const shell = pane.locator(".term-overlay.term-embedded");
    await expect(shell).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as unknown as { terminalCommands: { kind: string; sessionId?: string }[] }).terminalCommands.filter((c) => c.kind === "terminal.open").map((c) => c.sessionId))).toEqual(["s"]);
    await expect(shell.locator(".term-status")).toHaveText("Connected");
    const term = (await shell.boundingBox())!;
    expect(term.x).toBeGreaterThanOrEqual(box.x);
    expect(term.x + term.width).toBeLessThanOrEqual(box.x + box.width + 1);
    expect(term.y + term.height).toBeLessThanOrEqual(900 + 1);
    await expect(page.locator(".composer")).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath(`side-pane-terminal-${theme}.png`) });
    await shell.getByRole("button", { name: "End" }).click();
    await expect(pane.getByRole("tab", { name: /Changes/ })).toHaveAttribute("aria-selected", "true");

    await pane.getByRole("button", { name: "Hide side pane" }).click();
    await expect(pane).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
