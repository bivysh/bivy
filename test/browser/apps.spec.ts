// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, themes, type WebApp } from "./fixtures.js";
import path from "node:path";

let server: WebApp;
let origin: string;
test.beforeAll(async ({ webApp }) => {
  server = webApp;
  origin = webApp.origin;
});

for (const theme of themes) {
  test(`app web and terminal views, permissions and failure states (${theme})`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const html = await server.transformIndexHtml("/apps-test", `<html data-theme="${theme}"><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module">
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { ChatView } from '/src/components/ChatView.tsx';
      import { AppsSheet } from '/src/components/AppsSheet.tsx';
      import { onAppsSheetRequest } from '/src/appsSheetRequest.ts';
      import { controller } from '/src/store/controller.ts';
      import '/@fs/${path.resolve("packages/ui/tokens.css")}';
      import '/src/styles.css';
      import '/src/ux-cleanup.css';
      controller.store.setStatus('online');
      window.setConnection = status => controller.store.setStatus(status);
      window.mode = 'ready'; window.commands = []; window.terminalCommands = [];
      // Exercise the popup-blocked fallback without leaving this UI fixture.
      window.realOpen = window.open.bind(window);
      window.open = () => null;
      const app = {id:'a', sessionId:'s', name:'Accounting application with a deliberately long project name', createdAt:0, views:[
        {id:'web',kind:'web',name:'Website and invoice editor',source:'service',notes:[{id:'n1',at:1,note:'The total is cut off on my phone',selector:'td.total',text:'12 480',path:'/invoices',viewport:{width:390,height:844}}]},
        {id:'term',kind:'terminal',name:'Interactive application console',command:'bin/rails',args:['console','--environment=development-with-a-long-name']}
      ]};
      controller.appCommand = async (kind, sessionId, fields) => {
        window.commands.push({kind, sessionId, ...fields});
        await new Promise(r => setTimeout(r, 150));
        if(window.mode === 'error') throw Error('Machine unavailable. Reconnect and try again.');
        if(kind === 'apps.offers') return {offers:window.mode === 'ready' ? [{port:5173,pid:42,command:'node vite --port 5173 --host 127.0.0.1'}] : []};
        if(kind === 'apps.adopt') return {app:{id:'b',sessionId:'s',name:'node vite · :5173',createdAt:1,views:[{id:'adopted',kind:'web',name:'Port 5173',source:'service'}]}};
        if(kind === 'apps.list') return {apps:window.mode === 'empty' ? [] : [structuredClone(app)], previewAvailable:window.mode !== 'unconfigured'};
        if(kind === 'apps.open') return fields.viewId === 'term' ? {kind:'terminal',termId:'test-terminal'} : {kind:'web',url:'https://random.preview.example.net/__bivy/open#ticket'};
        if(kind === 'apps.share') { app.views[0].sharing = {links:1, expiresAt:Date.now() + 7 * 86400000}; return {url:'https://random.preview.example.net/__bivy/open#shared', expiresAt:Date.now() + 7 * 86400000, controls:fields.controls}; }
        if(kind === 'apps.unshare') delete app.views[0].sharing;
        return {ok:true};
      };
      // The session menu opens the sheet unscoped, which also lists detected servers.
      window.noteArrives = note => { app.views[0].notes = [note]; controller.appsChangedListeners.forEach(fn => fn('s')); };
      window.showSheet = (request = {sessionId:'s'}) => { const host = document.body.appendChild(document.createElement('div')); const root = createRoot(host); root.render(React.createElement(AppsSheet, {...request, onClose(){ root.unmount(); host.remove(); }})); };
      // The app shell owns the sheet that chat cards open; stand in for it.
      onAppsSheetRequest(request => window.showSheet(request));
      const handlers = new Set();
      controller.onTerminal = fn => {handlers.add(fn); return () => handlers.delete(fn);};
      window.terminalEvent = event => handlers.forEach(fn => fn(event));
      controller.sendTerminal = command => {
        window.terminalCommands.push(command);
        if(command.kind === 'terminal.attach') setTimeout(() => {window.terminalEvent({type:'terminal.attached',termId:command.termId,data:'App REPL ready\\r\\n> '});window.attached = (window.attached || 0) + 1;}, 20);
      };
      createRoot(document.getElementById('root')).render(React.createElement(ChatView, {
        entries:[{id:'user',role:'user',text:'Build me an invoice editor with a console.'},{id:'reply',role:'assistant',text:'The invoice workbench is ready. Open it below to try it.'},{id:'app',role:'assistant',text:'',app:{appId:'a',sessionId:'s',name:app.name}}],
        working:false,workingLabel:'',draftRoute:false,sessionKey:'s',focusView:false
      }));
    </script></body></html>`);
    await page.route(`${origin}/apps-test`, (route) => route.fulfill({ contentType: "text/html", body: html }));
    await page.goto(`${origin}/apps-test`);
    await expect(page.getByRole("button", { name: /^Open app:/ })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`chat-app-${theme}.png`), fullPage: true });
    await page.getByRole("button", { name: /^Open app:/ }).click();
    await expect(page.getByRole("dialog", { name: "Session apps" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open preview" })).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`apps-${theme}.png`), fullPage: true });
    // Notes from people with a shared link show as text and can be cleared.
    const notes = page.getByRole("group", { name: "Reviewer notes on Website and invoice editor" });
    await expect(notes).toContainText("“The total is cut off on my phone” on “12 480” · /invoices");
    // A note sent while the sheet is open shows up without reopening it.
    await page.evaluate(() => (window as any).noteArrives({ id: "n2", at: 2, note: "Logo is blurry", selector: "img.logo", text: "", path: "/", viewport: { width: 390, height: 844 } }));
    await expect(notes).toContainText("“Logo is blurry”");
    await notes.getByRole("button", { name: "Clear" }).click();
    await expect.poll(() => page.evaluate(() => (window as any).commands.some((c: any) => c.kind === "apps.clearNotes" && c.viewId === "web"))).toBe(true);
    // Agents read notes only when the owner turns it on, per app: an on/off switch, off by default.
    await expect(page.getByRole("button", { name: "Share Website and invoice editor" })).toBeEnabled(); // Clear has finished
    await page.getByRole("button", { name: /^More actions for Accounting application/ }).click();
    const agentNotes = page.getByRole("menuitemcheckbox", { name: "Agents can read notes" });
    await expect(agentNotes).toHaveAttribute("aria-checked", "false");
    await agentNotes.click();
    await expect.poll(() => page.evaluate(() => (window as any).commands.filter((c: any) => c.kind === "apps.agentNotes").map((c: any) => [c.appId, c.enabled]))).toEqual([["a", true]]);
    await expect(page.getByRole("button", { name: "Share Website and invoice editor" })).toBeEnabled();
    await page.getByRole("button", { name: /^More actions for Accounting application/ }).click();
    await expect(page.getByRole("menuitemcheckbox", { name: "Agents can read notes" })).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    // Explain access before granting it. Opening Share must not mint a link.
    await page.getByRole("button", { name: "Share Website and invoice editor" }).click();
    expect(await page.evaluate(() => (window as any).commands.some((c: any) => c.kind === "apps.share"))).toBe(false);
    // How long the link works and whether it carries the feedback tools.
    await page.getByRole("radio", { name: "7 days" }).click();
    await page.getByRole("switch", { name: "Feedback tools" }).click();
    await expect(page.getByText("People see only the app.")).toBeVisible();
    await page.getByRole("button", { name: "Copy share link", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Copied" })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: /Shared · 1 link until/ })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`apps-copied-${theme}.png`), fullPage: true });
    // Stopping ends the links only, after saying so.
    await page.getByRole("button", { name: "Stop sharing" }).click();
    await page.getByRole("dialog", { name: "Stop sharing?" }).getByRole("button", { name: "Stop sharing" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Sharing stopped" })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: /Shared · / })).toHaveCount(0);
    // Revocation explains the effect and allows cancellation before the command.
    await page.getByRole("button", { name: "Sharing options" }).click();
    await page.getByRole("menuitem", { name: "Revoke all access…", exact: true }).click();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(await page.evaluate(() => (window as any).commands.some((c: any) => c.kind === "apps.revoke"))).toBe(false);
    await page.getByRole("button", { name: "Sharing options" }).click();
    await page.getByRole("menuitem", { name: "Revoke all access…", exact: true }).click();
    await page.getByRole("button", { name: "Revoke access", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Access revoked" })).toBeVisible();
    expect(await page.evaluate(() => (window as any).commands.filter((c: any) => ["apps.share", "apps.unshare", "apps.revoke"].includes(c.kind)).map((c: any) => [c.kind, c.viewId, c.duration, c.controls]))).toEqual([["apps.share", "web", "7d", false], ["apps.unshare", "web", undefined, undefined], ["apps.revoke", "web", undefined, undefined]]);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: /^Share Interactive/ })).toHaveCount(0);
    // Wait for dismissal: the lower sheet is inert during the closing motion.
    await expect(page.getByRole("button", { name: "Copy share link", exact: true })).toHaveCount(0);
    // Web views peek in a drawer over the chat by default.
    await page.getByRole("button", { name: "Open preview" }).focus();
    await page.keyboard.press("Enter");
    const peek = page.getByRole("dialog", { name: /^Preview: Accounting application/ });
    await expect(peek.locator("iframe.preview-peek")).toHaveAttribute("src", "https://random.preview.example.net/__bivy/open#ticket");
    await page.screenshot({ path: testInfo.outputPath(`apps-peek-${theme}.png`), fullPage: true });
    // A tab is one tap away; when the browser blocks the popup, a link is offered.
    await peek.getByRole("button", { name: "Open in tab ↗" }).click();
    const link = page.getByRole("link", { name: "Open preview" });
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
    await page.context().route("https://random.preview.example.net/**", (route) => route.fulfill({ contentType: "text/html", body: "<h1>Preview opened</h1>" }));
    await page.evaluate(() => { window.open = (window as any).realOpen; });
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await page.getByRole("button", { name: "Open preview", exact: true }).click();
    const opened = page.waitForEvent("popup");
    await page.getByRole("button", { name: "Open in tab ↗" }).click();
    const popup = await opened;
    await expect(popup.getByRole("heading", { name: "Preview opened" })).toBeVisible();
    expect(await popup.evaluate(() => window.opener === null)).toBe(true);
    await popup.close();
    await expect(page.getByRole("dialog", { name: "Session apps" })).toHaveCount(0);
    await page.getByRole("button", { name: /^Open app:/ }).click();
    await page.getByRole("button", { name: "Open terminal", exact: true }).click();
    await expect(page.getByRole("dialog").last()).toContainText("Only run code you trust");
    await page.screenshot({ path: testInfo.outputPath(`apps-confirm-${theme}.png`), fullPage: true });
    await page.getByRole("dialog").last().getByRole("button", { name: "Open terminal", exact: true }).click();
    await expect(page.locator(".xterm")).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).terminalCommands.some((c: any) => c.kind === "terminal.attach"))).toBe(true);
    await expect.poll(() => page.evaluate(() => (window as any).attached)).toBe(1);
    await page.evaluate(() => (window as any).setConnection("offline"));
    await expect(page.locator(".xterm")).toBeVisible();
    await page.evaluate(() => (window as any).setConnection("online"));
    await expect.poll(() => page.evaluate(() => (window as any).attached)).toBe(2);
    await page.evaluate(() => (window as any).terminalEvent({ type: "terminal.gone", termId: "test-terminal" }));
    await expect(page.getByText("App stopped — reopen its view to start again")).toBeVisible();
    expect(await page.evaluate(() => (window as any).terminalCommands.some((c: any) => c.kind === "terminal.open"))).toBe(false);
    // Return through the terminal's existing accessible close control.
    await page.getByRole("button", { name: "Close terminal", exact: true }).click();
    await page.evaluate(() => { (window as any).mode = "error"; });
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Machine unavailable");
    await page.evaluate(() => { (window as any).mode = "empty"; });
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.getByText(/No apps yet/)).toBeVisible();
    await page.evaluate(() => { (window as any).mode = "unconfigured"; });
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.getByRole("button", { name: "Open preview" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Open terminal", exact: true })).toBeEnabled();
    await expect(page.getByText("Bivy’s preview service is unavailable.", { exact: false })).toBeVisible();
    await expect(page.getByText(/preview domain configured/)).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`apps-unavailable-${theme}.png`), fullPage: true });
    // A server the agent started is one tap from a preview: adopt, then open.
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Session apps" })).toHaveCount(0);
    await page.evaluate(() => { (window as any).mode = "ready"; (window as any).showSheet(); });
    await expect(page.getByRole("region", { name: "Running in this workspace" })).toContainText("node vite --port 5173");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`apps-detected-${theme}.png`), fullPage: true });
    // A browser that blocks framed preview cookies gets a tab from then on.
    await page.context().route("https://random.preview.example.net/__bivy/open", (route) => route.fulfill({ contentType: "text/html", body: `<script>parent.postMessage({source:"bivy-preview",type:"blocked"},"*")</script>` }));
    await page.getByRole("button", { name: "Preview port 5173" }).click();
    await expect(page.getByRole("status").filter({ hasText: "previews will open in a tab on this device" })).toBeVisible();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("bivy.previewPeekBlocked")!).agent === navigator.userAgent)).toBe(true);
    await page.context().unroute("https://random.preview.example.net/__bivy/open");
    await page.keyboard.press("Escape");
    await page.evaluate(() => { (window as any).mode = "ready"; (window as any).showSheet(); });
    const tab = page.waitForEvent("popup");
    await page.getByRole("button", { name: "Open preview", exact: true }).last().click();
    await expect((await tab).getByRole("heading", { name: "Preview opened" })).toBeVisible();
    // Only for this browser version: after an update the drawer gets a new try.
    await page.evaluate(() => localStorage.setItem("bivy.previewPeekBlocked", JSON.stringify({ agent: "an older version", at: Date.now() })));
    await page.keyboard.press("Escape");
    await page.evaluate(() => { (window as any).showSheet(); });
    await page.getByRole("button", { name: "Preview port 5173" }).click();
    await expect(page.getByRole("dialog", { name: "Preview: node vite · :5173" }).frameLocator("iframe").getByRole("heading", { name: "Preview opened" })).toBeVisible();
    expect(await page.evaluate(() => (window as any).commands.filter((c: any) => c.kind === "apps.adopt" || c.kind === "apps.open").slice(-2).map((c: any) => [c.kind, c.port ?? c.viewId]))).toEqual([["apps.adopt", 5173], ["apps.open", "adopted"]]);
    expect(errors).toEqual([]);
  });
}
