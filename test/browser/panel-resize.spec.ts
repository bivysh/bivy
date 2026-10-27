// SPDX-License-Identifier: MIT
import { expect, test, themes } from "./fixtures.js";
import path from "node:path";

// On desktop the sidebar and the side pane are resizable by dragging their
// inner edge. This mounts the real ResizeHandle + usePanelWidth in the app's
// real grid and checks drag, keyboard, clamping, reset and that the width
// survives a reload.
for (const theme of themes) {
  test(`sidebar and side pane resize by dragging (${theme})`, async ({ page, webApp }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.setViewportSize({ width: 1440, height: 900 });
    const html = await webApp.transformIndexHtml("/panel-resize", `<html data-theme="${theme}"><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module">
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { SidePane } from '/src/components/SidePane.tsx';
      import { ResizeHandle } from '/src/components/ResizeHandle.tsx';
      import { SIDEBAR_SIZE, SIDE_PANE_SIZE, usePanelWidth } from '/src/usePanelWidth.ts';
      import '/@fs/${path.resolve("packages/ui/tokens.css")}';
      import '/src/styles.css';
      import '/src/ux-cleanup.css';
      const h = React.createElement;
      const rows = [
        ['Onboarding review: hosted + self-host', 'Claude · bivy-agent-staging · bivysh/bivy', 'now'],
        ['Help me decide on the pricing page', 'Codex · bivy-agent-staging', '3h'],
        ["I've answered the questions in the doc", 'Pi · bivy-agent-staging · bivysh/bivy', '1d'],
      ];
      function Shell() {
        const [sidebar, setSidebar] = usePanelWidth(SIDEBAR_SIZE);
        const [pane, setPane] = usePanelWidth(SIDE_PANE_SIZE);
        const style = {};
        if (sidebar !== null) style['--sidebar-col'] = sidebar + 'px';
        if (pane !== null) style['--pane-col'] = pane + 'px';
        return h('div', { className: 'app has-pane', style },
          h('aside', { className: 'sidebar', 'aria-label': 'Sessions' },
            h(ResizeHandle, { label: 'Resize sidebar', edge: 'end', size: SIDEBAR_SIZE, width: sidebar, onResize: setSidebar }),
            h('div', { className: 'sidebar-head' }, h('span', { className: 'brand' }, 'Bivy')),
            h('div', { className: 'session-list' }, h('ul', null, rows.map(([name, meta, age]) =>
              h('li', { key: name, className: 'session-row' }, h('button', { className: 'session-item' },
                h('span', { className: 'session-body' },
                  h('span', { className: 'session-title-row' }, h('span', { className: 'session-name' }, name), h('span', { className: 'session-age' }, age)),
                  h('span', { className: 'session-meta' }, meta)))))))),
          h('main', { className: 'main' },
            h('header', { className: 'topbar' }, h('div', { className: 'topbar-title' }, h('h1', { className: 'title' }, 'Onboarding review')))),
          h(SidePane, {
            tabs: [{ id: 'changes', label: 'Changes' }], active: 'changes', onSelect() {}, onClose() {},
            handle: h(ResizeHandle, { label: 'Resize side pane', edge: 'start', size: SIDE_PANE_SIZE, width: pane, onResize: setPane }),
          }, h('p', null, 'Changes')));
      }
      createRoot(document.getElementById('root')).render(h(Shell));
    </script></body></html>`);
    await page.route(`${webApp.origin}/panel-resize`, (route) => route.fulfill({ contentType: "text/html", body: html }));
    await page.goto(`${webApp.origin}/panel-resize`);

    const sidebar = page.locator(".sidebar");
    const pane = page.locator(".side-pane");
    const width = async (el: typeof sidebar) => (await el.boundingBox())!.width;
    const drag = async (name: string, dx: number) => {
      const box = (await page.getByRole("separator", { name }).boundingBox())!;
      const x = box.x + box.width / 2, y = box.y + box.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + dx / 2, y);
      await page.mouse.move(x + dx, y);
      await page.mouse.up();
    };

    const sidebarStart = await width(sidebar);
    await drag("Resize sidebar", 120);
    expect(Math.round(await width(sidebar))).toBe(Math.round(sidebarStart + 120));
    // The pane's edge is on its left: dragging left grows it.
    const paneStart = await width(pane);
    await drag("Resize side pane", -100);
    expect(Math.round(await width(pane))).toBe(Math.round(paneStart + 100));
    await page.screenshot({ path: testInfo.outputPath(`panel-resize-${theme}.png`) });

    // Clamped to the panel's bounds, however far the pointer goes.
    await drag("Resize sidebar", 2000);
    expect(await width(sidebar)).toBe(480);
    // Keyboard: arrows step the width, the separator reports it.
    const handle = page.getByRole("separator", { name: "Resize sidebar" });
    await handle.focus();
    await page.keyboard.press("ArrowLeft");
    await expect(handle).toHaveAttribute("aria-valuenow", "464");

    // Remembered across a reload.
    await page.reload();
    expect(await width(sidebar)).toBe(464);
    expect(Math.round(await width(pane))).toBe(Math.round(paneStart + 100));

    // Double-click restores the default.
    await handle.dblclick();
    expect(await width(sidebar)).toBe(sidebarStart);
    expect(errors).toEqual([]);
  });
}
