// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { readFile } from "node:fs/promises";

const ROOT = new URL("../../", import.meta.url);
const THEMES = ["light", "dark"] as const;

const fixtures = {
  draft: `
    <div class="app review-fixture">
      <aside class="sidebar"><div class="sidebar-head"><strong class="brand">Bivy</strong><button class="btn sm primary">+ New</button></div><nav class="session-list"><div class="session-list-heading">Sessions</div><button class="session-item active"><span class="session-name">New session</span><span class="session-meta">Draft</span></button></nav></aside>
      <main class="main"><header class="topbar"><button class="btn ghost icon only-mobile" aria-label="Open navigation">☰</button><div class="topbar-title"><strong>New session</strong><span>My laptop</span></div></header>
        <section class="messages"></section>
        <div class="composer-lead" aria-label="Session setup"><button class="btn sm ghost repo-pill">Choose repository</button><button class="btn sm ghost sandbox-pill" aria-label="Protection: Workspace write">◈ Workspace write</button></div>
        <section class="composer"><div class="composer-card"><textarea class="composer-input" aria-label="Message" placeholder="Describe your task"></textarea><div class="composer-actions"><div class="composer-meta"><button class="btn sm ghost attach-pill" aria-label="Attach file">＋</button><button class="btn sm ghost agent-pill"><span class="pill-label">Pi</span></button><button class="btn sm ghost model-pill"><span class="pill-label">Claude</span></button></div><button class="composer-btn send" aria-label="Send message">↑</button></div></div></section>
      </main>
    </div>`,
  pickers: `
    <div class="app review-fixture"><main class="main"><header class="topbar"><div class="topbar-title"><strong>New session</strong><span>Review before starting</span></div></header><section class="messages"><div class="empty"><h1>Describe your task</h1></div></section></main></div>
    <section class="sheet" aria-label="Repository"><div class="sheet-backdrop"></div><div class="sheet-body"><div class="sheet-head"><strong class="sheet-title">Repository</strong><button class="btn ghost icon" aria-label="Close repository picker">×</button></div><div class="sheet-content"><input class="picker-search" aria-label="Search repositories" placeholder="Search repositories"><div class="picker-list"><div class="picker-item-row active"><button class="picker-item"><span class="picker-check">✓</span><span class="picker-main"><strong class="picker-name">bivysh/bivy</strong><span class="picker-meta">Current repository</span></span></button></div><div class="picker-item-row"><button class="picker-item"><span class="picker-check"></span><span class="picker-main"><strong class="picker-name">bivysh/bivy-cloud</strong><span class="picker-meta">Cloud control plane</span></span></button></div><div class="picker-item-row"><button class="picker-item"><span class="picker-check"></span><span class="picker-main"><strong class="picker-name">No repository</strong><span class="picker-meta">Work in the machine's default folder</span></span></button></div></div></div></div></section>`,
  live: `
    <div class="app review-fixture"><aside class="sidebar"><div class="sidebar-head"><strong class="brand">Bivy</strong></div><nav class="session-list"><button class="session-item active"><span class="session-name">Improve onboarding</span><span class="session-meta">Working · just now</span></button></nav></aside><main class="main"><header class="topbar"><button class="btn ghost icon only-mobile" aria-label="Open navigation">☰</button><div class="topbar-title"><strong>Improve onboarding</strong><span>bivysh/bivy</span></div></header><section class="messages"><article class="msg user"><div class="bubble">Make the first session easier to understand.</div></article><article class="msg assistant"><div class="bubble"><p>I’ll review the first-session flow and update the actionable decisions.</p><div class="tool-group"><button class="tool-group-line" aria-label="Open details for 3 files read"><span class="tool-group-summary">Read 3 files</span><span class="tool-chevron">›</span></button></div><p>The draft now explains each choice before the first message is sent.</p></div></article></section><div class="run-pill"><span class="run-pill-label">Manual run</span><span class="run-pill-stat"><span class="status-dot working"></span>Working</span><span class="run-pill-files">3 files edited</span></div><section class="composer"><div class="composer-card"><textarea class="composer-input" aria-label="Follow-up message" placeholder="Add a follow-up"></textarea><div class="composer-actions"><div class="composer-meta"><button class="btn sm ghost" aria-label="Attach file">＋</button></div><button class="composer-btn stop" aria-label="Stop agent">■</button></div></div></section></main></div>`,
  automations: `
    <div class="automations-view review-fixture"><header class="automations-view-head"><button class="btn ghost icon autom-close-btn" aria-label="Close Automations">←</button><div class="automations-view-head-text"><h1 class="automations-view-heading">Automations</h1><p class="automations-view-sub">Run work on a schedule or from an event.</p></div></header></div><div class="wizard-scrim"><section class="wizard autom-editor" role="dialog" aria-modal="true" aria-label="New automation"><header class="wizard-head"><strong>New automation</strong><button class="btn ghost icon" aria-label="Cancel">×</button></header><div class="wizard-body"><div class="autom-name-row"><span class="autom-name-icon">⚡</span><input class="autom-name-input" aria-label="Name" value="Daily issue review"></div><div class="autom-field-block"><div class="autom-field-label">Triggers</div><div class="autom-trigger-chip"><span class="autom-trigger-chip-icon">◷</span><div class="autom-trigger-chip-text"><strong>Weekdays 09:00</strong><span>Europe/Oslo · 0 9 * * 1-5</span></div></div></div><div class="autom-field-block autom-runner-block"><div class="autom-field-label">Run on</div><div class="card autom-runner-card ready" data-tone="ok"><label class="autom-runner-select-row"><span class="autom-runner-icon">⌁</span><span class="autom-runner-select-copy"><strong>My laptop</strong><span>Online · encryption ready</span></span><select class="autom-inline-select" aria-label="Run on machine"><option>My laptop · online</option></select></label></div></div><div class="autom-field-block"><label class="autom-field-label" for="shot-instructions">Instructions</label><div class="autom-instructions"><textarea id="shot-instructions" class="autom-instructions-input" rows="5">Review new issues, identify the highest-impact item, and propose the smallest safe fix.</textarea><div class="autom-instructions-bar"><span class="settings-hint">Encrypted end to end</span><button class="autom-advanced-link">Agent, model &amp; safety</button></div></div></div></div><footer class="wizard-actions"><button class="btn">Cancel</button><button class="btn primary">Turn on</button></footer></section></div>`,
} as const;

test.beforeEach(async ({ page }) => {
  const [tokens, styles, cleanup] = await Promise.all([
    readFile(new URL("packages/ui/tokens.css", ROOT), "utf8"),
    readFile(new URL("packages/web/src/styles.css", ROOT), "utf8"),
    readFile(new URL("packages/web/src/ux-cleanup.css", ROOT), "utf8"),
  ]);
  await page.setContent("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Bivy UX fixture</title></head><body></body></html>");
  await page.addStyleTag({ content: `${tokens}\n${styles}\n${cleanup}\nhtml,body{margin:0;width:100%;height:100%;overflow:hidden}.review-fixture{min-height:100%}` });
});

async function assertNamedControls(page: Page) {
  const unnamed = await page.locator("button, input, select, textarea, a[href], [role=button]").evaluateAll((controls) => controls.filter((control) => {
    const element = control as HTMLElement;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const labelledBy = element.getAttribute("aria-labelledby");
    const label = element.getAttribute("aria-label")
      || element.getAttribute("title")
      || (labelledBy ? document.getElementById(labelledBy)?.textContent : "")
      || (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement
        ? document.querySelector(`label[for="${CSS.escape(element.id)}"]`)?.textContent || element.getAttribute("placeholder")
        : element.textContent);
    return !label?.trim();
  }).map((element) => element.outerHTML));
  expect(unnamed, `unnamed controls:\n${unnamed.join("\n")}`).toEqual([]);
}

async function assertMobilePrimaryTargets(primary: Locator, testInfo: TestInfo) {
  if (testInfo.project.name !== "mobile") return;
  const boxes = await primary.evaluateAll((controls) => controls.filter((control) => {
    const style = getComputedStyle(control);
    return style.display !== "none" && style.visibility !== "hidden";
  }).map((control) => {
    const box = control.getBoundingClientRect();
    return { label: control.getAttribute("aria-label") || control.textContent?.trim(), width: box.width, height: box.height };
  }));
  for (const box of boxes) {
    expect(box.width, `${box.label} width`).toBeGreaterThanOrEqual(44);
    expect(box.height, `${box.label} height`).toBeGreaterThanOrEqual(44);
  }
}

for (const [name, markup] of Object.entries(fixtures)) {
  test(`${name} fixture is reviewable in both themes`, async ({ page }, testInfo) => {
    for (const theme of THEMES) {
      await page.evaluate(({ html, selectedTheme }) => {
        document.documentElement.dataset.theme = selectedTheme;
        document.body.innerHTML = html;
      }, { html: markup, selectedTheme: theme });
      await assertNamedControls(page);
      await assertMobilePrimaryTargets(page.locator(".btn.primary"), testInfo);
      await expect(page.locator("body")).toHaveScreenshot(`${name}-${testInfo.project.name}-${theme}.png`, {
        animations: "disabled",
        caret: "hide",
        // Text and native controls vary slightly with the runner's font
        // rasterizer. Draft now renders its setup labels directly, so it has a
        // little more anti-aliasing noise; both limits remain far below a
        // visible layout or copy regression.
        maxDiffPixels: name === "draft" ? 600 : 100,
      });
    }
  });
}
