// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, themes, type WebApp } from "./fixtures.js";
import path from "node:path";

let server: WebApp;
let origin: string;
test.beforeAll(async ({ webApp }) => {
  server = webApp;
  origin = webApp.origin;
});

/** The Artifacts / Apps pages over a fake machine, plus a ChatView whose
 *  history is longer than its initial window. */
async function mount(page: import("@playwright/test").Page, theme: string) {
  const html = await server.transformIndexHtml("/library-test", `<html data-theme="${theme}"><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module">
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { LibraryView } from '/src/components/LibraryView.tsx';
    import { ChatView } from '/src/components/ChatView.tsx';
    import { requestMessageJump } from '/src/messageJump.ts';
    import { controller } from '/src/store/controller.ts';
    import '/@fs/${path.resolve("packages/ui/tokens.css")}';
    import '/src/styles.css';
    import '/src/ux-cleanup.css';
    controller.store.setStatus('online');
    controller.direct = false; // an account client, with several machines
    controller.store.setNodes([{id:'n1',name:'Mac mini',online:true},{id:'n2',name:'Build server',online:true},{id:'n3',name:'Laptop',online:true}]);
    controller.store.setSessions([{id:'s1',nodeId:'n1',name:'Quarterly revenue report'},{id:'s2',nodeId:'n2',name:'Landing page redesign with a deliberately long session title'}]);
    const canvas = Object.assign(document.createElement('canvas'), {width:320, height:240});
    const g = canvas.getContext('2d'); g.fillStyle = '#6b8afd'; g.fillRect(0,0,320,240); g.fillStyle = '#fff'; g.fillRect(40,60,240,120);
    const png = canvas.toDataURL('image/png').split(',')[1];
    controller.fetchAttachment = async () => ({mimeType:'image/png', data:png});
    const day = 86400000;
    controller.listMachineArtifacts = async () => ({unreachable:['Laptop'], items:[
      {nodeId:'n1',sessionId:'s1',hash:'h1',name:'revenue-chart.png',mimeType:'image/png',kind:'image',size:48000,createdAt:Date.now()-3600000,artifact:true},
      {nodeId:'n1',sessionId:'s1',hash:'h2',name:'q3-report.pdf',mimeType:'application/pdf',kind:'file',size:1200000,createdAt:Date.now()-day,artifact:true},
      {nodeId:'n2',sessionId:'s2',hash:'h3',name:'hero-mobile-screenshot-after-the-spacing-fix.png',mimeType:'image/png',kind:'image',size:90000,createdAt:Date.now()-3*day,artifact:false},
      {nodeId:'n2',sessionId:'s2',hash:'h4',name:'dist.zip',mimeType:'application/zip',kind:'file',size:5400000,createdAt:Date.now()-9*day,artifact:false},
    ]});
    controller.listMachineApps = async () => ({unreachable:[], items:[
      {nodeId:'n2',id:'a1',sessionId:'s2',name:'Landing page',createdAt:Date.now()-2*day,views:[{id:'v1',kind:'web',name:'Site',source:'service'}]},
      {nodeId:'n1',id:'a2',sessionId:'s1',name:'Revenue explorer',createdAt:Date.now()-day,views:[{id:'v2',kind:'web',name:'Dashboard',source:'static'},{id:'v3',kind:'terminal',name:'REPL',command:'python',args:[]}]},
    ]});
    window.shown = [];
    const root = createRoot(document.getElementById('root'));
    window.showLibrary = (view) => root.render(React.createElement(LibraryView, {view, onClose(){}, onShowInChat(sessionId, target, nodeId){ window.shown.push({sessionId, nodeId, ...target}); }}));
    window.showChat = (target) => {
      requestMessageJump('s1', target);
      const entries = Array.from({length: 60}, (_, i) => ({id:'e'+i, role: i % 2 ? 'assistant' : 'user', text:'Message '+i}));
      entries[3] = {id:'e3', role:'assistant', text:'Here is the chart.', attachments:[{kind:'image',name:'revenue-chart.png',size:48000,mimeType:'image/png',hash:'h1'}]};
      root.render(React.createElement(ChatView, {entries, working:false, workingLabel:'', draftRoute:false, sessionKey:'s1', focusView:false}));
    };
  </script></body></html>`);
  await page.route(`${origin}/library-test`, (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto(`${origin}/library-test`);
  await page.waitForFunction(() => "showLibrary" in window);
}

for (const theme of themes) {
  test(`Artifacts and Apps pages link each item back to its message (${theme})`, async ({ page }) => {
    await mount(page, theme);
    // Review aid: LIBRARY_SHOTS=<dir> saves each state at desktop and phone width.
    const shot = async (name: string) => {
      const dir = process.env.LIBRARY_SHOTS;
      if (!dir) return;
      await page.screenshot({ path: path.join(dir, `${name}-${theme}-desktop.png`) });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: path.join(dir, `${name}-${theme}-mobile.png`) });
      await page.setViewportSize({ width: 1280, height: 800 });
    };

    await page.evaluate(() => (window as unknown as { showLibrary: (v: string) => void }).showLibrary("artifacts"));
    const grid = page.getByRole("list", { name: "Artifacts" });
    await expect(grid.getByRole("listitem")).toHaveCount(4);
    await expect(grid.locator("img").first()).toBeVisible();
    // A machine that didn't answer is named, not silently missing.
    await expect(page.getByRole("status").filter({ hasText: "Couldn’t reach Laptop" })).toBeVisible();
    await shot("artifacts");
    await page.getByRole("tab", { name: "Files" }).click();
    await expect(grid.getByRole("listitem")).toHaveCount(2);
    await grid.getByRole("button", { name: /Show in chat: Quarterly revenue report/ }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { shown: unknown[] }).shown)).toEqual([{ sessionId: "s1", nodeId: "n1", hash: "h2" }]);

    await page.evaluate(() => (window as unknown as { showLibrary: (v: string) => void }).showLibrary("apps"));
    const apps = page.getByRole("list", { name: "Apps" });
    await expect(apps.getByRole("listitem")).toHaveCount(2);
    await expect(apps.getByRole("listitem").filter({ has: page.getByRole("button", { name: "Open Landing page", exact: true }) })).toContainText("Build server");
    await shot("apps");
    await apps.getByRole("button", { name: /Show in chat: Landing page redesign/ }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { shown: unknown[] }).shown.at(-1))).toEqual({ sessionId: "s2", nodeId: "n2", appId: "a1" });

    // The chart's message is far above the initial window: the jump mounts it
    // and scrolls it into view instead of leaving the chat at the bottom.
    await page.evaluate(() => (window as unknown as { showChat: (t: unknown) => void }).showChat({ hash: "h1" }));
    const target = page.locator(".assistant-row", { hasText: "Here is the chart." });
    await expect(target).toBeInViewport();
    await expect(target).toHaveClass(/is-jump-target/);
    await shot("jump");
  });
}
