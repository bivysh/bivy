// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, themes, type WebApp } from "./fixtures.js";
import path from "node:path";

// The published-app launcher card anchors chronologically in the transcript, so
// after a long turn it scrolls out of view. The Apps pill at the right end of
// the band above the composer is the stable way back, and it counts reviewer
// notes left since the owner last opened the Apps sheet. This renders the real
// band (run pill + Apps pill) at phone width and proves the pill sits right,
// shows new notes, fires, and drops the count once the notes are marked seen.
let server: WebApp;
let origin: string;
test.beforeAll(async ({ webApp }) => {
  server = webApp;
  origin = webApp.origin;
});

for (const theme of themes) {
  test(`apps pill sits right of the band and flags new reviewer notes (${theme})`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.setViewportSize({ width: 390, height: 300 });
    const html = await server.transformIndexHtml("/apps-pill", `<html data-theme="${theme}"><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root" style="display:flex;flex-direction:column"></div><script type="module">
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { RunPill } from '/src/components/RunPill.tsx';
      import { AppsPill } from '/src/components/AppsPill.tsx';
      import { useNewNotes, markNotesSeen } from '/src/notesSeen.ts';
      import '/@fs/${path.resolve("packages/ui/tokens.css")}';
      import '/src/styles.css';
      import '/src/ux-cleanup.css';
      localStorage.clear();
      window.opened = 0;
      const noteTimes = [1000, 2000];
      function Band() {
        const newNotes = useNewNotes('s1', noteTimes);
        return React.createElement('div', { className: 'composer-gh' },
          React.createElement(RunPill, {
            anchorId: 'attention-s1',
            source: { kind: 'cli', label: 'Terminal session', automation: false },
            statusClass: 'idle', statusLabel: 'Idle',
            gh: { issueUrl: null, prUrl: null, branch: null, repo: null, prs: [] },
            filesEdited: 3, onOpenChanges: () => {},
          }),
          React.createElement(AppsPill, { apps: 2, serverPorts: [3000], newNotes, onOpen: () => { window.opened += 1; markNotesSeen('s1', 2000); } }));
      }
      createRoot(document.getElementById('root')).render(React.createElement(Band));
    </script></body></html>`);
    await page.route(`${origin}/apps-pill`, (route) => route.fulfill({ contentType: "text/html", body: html }));
    await page.goto(`${origin}/apps-pill`);

    const pill = page.getByRole("button", { name: "Open apps · 2 apps · 2 new notes" });
    await expect(pill).toContainText("2 new notes");
    // Right-aligned in the band, clear of the run pill, no horizontal overflow.
    const band = (await page.locator(".composer-gh").boundingBox())!;
    const box = (await pill.boundingBox())!;
    const run = (await page.locator("#attention-s1").boundingBox())!;
    expect(Math.abs(box.x + box.width - (band.x + band.width - 12))).toBeLessThan(2);
    expect(run.x + run.width).toBeLessThan(box.x);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`apps-pill-${theme}.png`) });

    await pill.focus();
    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => (window as unknown as { opened: number }).opened)).toBe(1);
    await expect(page.getByRole("button", { name: "Open apps · 2 apps" })).not.toContainText("new note");
    expect(errors).toEqual([]);
  });
}

test("apps pill renders nothing without apps or servers", async ({ page }) => {
  const html = await server.transformIndexHtml("/apps-pill-none", `<html><head></head><body><div id="root"></div><script type="module">
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { AppsPill } from '/src/components/AppsPill.tsx';
    createRoot(document.getElementById('root')).render(React.createElement(AppsPill, { apps: 0, serverPorts: [], newNotes: 3, onOpen: () => {} }));
    window.rendered = true;
  </script></body></html>`);
  await page.route(`${origin}/apps-pill-none`, (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto(`${origin}/apps-pill-none`);
  await expect.poll(() => page.evaluate(() => (window as unknown as { rendered?: boolean }).rendered)).toBe(true);
  await expect(page.locator("#root")).toBeEmpty();
});
