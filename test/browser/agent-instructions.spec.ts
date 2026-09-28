// SPDX-License-Identifier: AGPL-3.0-only
// Settings → Agent instructions: editing, saving against the loaded version, a
// save rejected because another device changed them, and the size limit — in
// the real Settings modal with real styles.
import { expect, test, themes, type WebApp } from "./fixtures.js";
import path from "node:path";

let server: WebApp;
let origin: string;
test.beforeAll(async ({ webApp }) => {
  server = webApp;
  origin = webApp.origin;
});

for (const theme of themes) {
  test(`agent instructions ${theme}`, async ({ page }, testInfo) => {
    const html = await server.transformIndexHtml("/agent-instructions-test", `<html data-theme="${theme}"><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module">
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { Settings } from '/src/components/Settings.tsx';
      import { controller } from '/src/store/controller.ts';
      import '/@fs/${path.resolve("packages/ui/tokens.css")}';
      import '/src/styles.css';
      import '/src/ux-cleanup.css';
      controller.getNodeSettings = () => {};
      let state = structuredClone(controller.store.getState());
      state.connection.status = 'online';
      const setInstructions = (agentInstructions) => {
        state = { ...state, settings: { ...state.settings, nodeSettings: { name: 'studio', agentInstructions } } };
        render();
      };
      window.setInstructions = setInstructions;
      window.saves = [];
      window.rejectSave = false;
      controller.setNodeSettings = async (patch) => {
        window.saves.push(patch);
        await new Promise(resolve => setTimeout(resolve, 100));
        if (window.rejectSave) throw new Error('These instructions were changed on another device. Reload them before saving.');
        setInstructions({ text: patch.agentInstructions, updatedAt: patch.agentInstructionsBaseUpdatedAt + 1000, maxBytes: 64 });
      };
      const root = createRoot(document.getElementById('root'));
      function render() { root.render(React.createElement(Settings, { state, view: 'instructions', onViewChange() {}, onClose() {} })); }
      setInstructions({ text: '- Prefer pnpm.', updatedAt: 1000, maxBytes: 64 });
    </script></body></html>`);
    await page.route(`${origin}/agent-instructions-test`, route => route.fulfill({ contentType: "text/html", body: html }));
    await page.goto(`${origin}/agent-instructions-test`);

    const editor = page.getByLabel("Instructions (Markdown)");
    const save = page.getByRole("button", { name: "Save" });
    await expect(editor).toHaveValue("- Prefer pnpm.");
    await expect(save).toBeDisabled();
    await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {}))));
    await page.screenshot({ path: testInfo.outputPath("agent-instructions.png"), fullPage: true });

    // Save sends the edit with the version it was based on, then follows the node's echo.
    await editor.fill("- Prefer pnpm.\n- Run tests.");
    await expect(page.getByRole("button", { name: "Revert" })).toBeVisible();
    await save.click();
    await expect(page.getByRole("button", { name: "Saved" })).toBeVisible();
    expect(await page.evaluate(() => (window as any).saves)).toEqual([{ agentInstructions: "- Prefer pnpm.\n- Run tests.", agentInstructionsBaseUpdatedAt: 1000 }]);
    await expect(page.getByRole("button", { name: "Revert" })).toHaveCount(0);

    // An unsaved edit survives a sync from another device; the user chooses to load it.
    await editor.fill("my draft");
    await page.evaluate(() => (window as any).setInstructions({ text: "from phone", updatedAt: 9000, maxBytes: 64 }));
    await expect(editor).toHaveValue("my draft");
    await expect(page.getByRole("status")).toContainText("changed on another device");
    await expect(save).toBeDisabled();
    await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {}))));
    await page.screenshot({ path: testInfo.outputPath("agent-instructions-conflict.png"), fullPage: true });
    // Keep mine: the draft now saves over the newer copy.
    await page.getByRole("button", { name: "Keep mine" }).click();
    await expect(page.getByRole("status")).toHaveCount(0);
    await save.click();
    await expect(page.getByRole("button", { name: "Saved" })).toBeVisible();
    expect(await page.evaluate(() => (window as any).saves.at(-1))).toEqual({ agentInstructions: "my draft", agentInstructionsBaseUpdatedAt: 9000 });
    // Load latest discards the draft; a save the node rejects is reported.
    await editor.fill("another draft");
    await page.evaluate(() => (window as any).setInstructions({ text: "from phone", updatedAt: 20000, maxBytes: 64 }));
    await page.getByRole("button", { name: "Load latest" }).click();
    await expect(editor).toHaveValue("from phone");
    await page.evaluate(() => { (window as any).rejectSave = true; });
    await editor.fill("third draft");
    await save.click();
    await expect(page.getByRole("alert")).toContainText("changed on another device");

    // Over the size limit: explained, and not savable.
    await editor.fill("x".repeat(80));
    await expect(editor).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByText(/shorten the instructions/)).toBeVisible();
    await expect(save).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}
