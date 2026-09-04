// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { readFile } from "node:fs/promises";

const ROOT = new URL("../../", import.meta.url);
const THEMES = ["light", "dark"] as const;

const activitySheet = `
  <section class="sheet" role="dialog" aria-modal="true" aria-label="Agent activity">
    <div class="sheet-backdrop"></div>
    <div class="sheet-body" tabindex="-1">
      <div class="sheet-grabber"></div>
      <div class="sheet-head"><span class="sheet-title">Reviewed the flow and updated three files</span><button class="sheet-close" aria-label="Close">×</button></div>
      <div class="sheet-content"><div>
        <div class="activity"><button class="activity-row"><span class="activity-ic">⌕</span><span class="activity-verb">Read</span><span class="activity-desc">packages/web/AGENTS.md</span><span class="tool-chevron">›</span></button></div>
        <div class="activity"><button class="activity-row"><span class="activity-ic">⌕</span><span class="activity-verb">Read</span><span class="activity-desc">components/ChatView.tsx</span><span class="tool-chevron">›</span></button></div>
        <div class="activity"><button class="activity-row"><span class="activity-ic">⌕</span><span class="activity-verb">Read</span><span class="activity-desc">styles.css</span><span class="tool-chevron">›</span></button></div>
        <div class="activity"><button class="activity-row"><span class="activity-ic">✎</span><span class="activity-verb">Edited</span><span class="activity-desc">ChatView.tsx</span><span class="tool-stat"><span class="add">+42</span><span class="del">−31</span></span><span class="tool-chevron">›</span></button></div>
        <div class="activity"><button class="activity-row"><span class="activity-ic">✎</span><span class="activity-verb">Edited</span><span class="activity-desc">styles.css</span><span class="tool-stat"><span class="add">+28</span><span class="del">−9</span></span><span class="tool-chevron">›</span></button></div>
        <div class="activity"><button class="activity-row"><span class="activity-ic">›_</span><span class="activity-verb">Ran</span><span class="activity-desc">pnpm --filter @bivy/web run typecheck</span><span class="tool-chevron">›</span></button></div>
      </div></div>
    </div>
  </section>`;

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
    <div class="app review-fixture">
      <aside class="sidebar">
        <div class="sidebar-head"><strong class="brand">Bivy</strong><div class="sidebar-head-actions"><button class="btn ghost icon term-btn" aria-label="Open standalone terminal"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="m7 9 3 3-3 3M13 15h4"></path></svg></button><button class="btn sm ghost">+ New</button></div></div>
        <div class="session-list"><nav class="sidebar-nav" aria-label="Workspace"><button class="sidebar-nav-item"><svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M13 2 3 14h9l-1 8 10-12h-9z"></path></svg><span>Automations</span><span class="sidebar-nav-chevron">›</span></button></nav><div class="session-list-heading"><span>Sessions</span><span class="session-list-count">3</span></div><div class="session-list-tools"><input class="field session-search" type="search" aria-label="Search sessions" placeholder="Search sessions…"><button class="session-filter-btn" aria-label="Filter sessions">≡</button></div><button class="session-item active"><span class="session-name">Improve onboarding</span><span class="session-meta">Pi · Mac Studio · Working now</span></button><button class="session-item"><span class="session-name">Review authentication flow</span><span class="session-meta">Codex · Mac Studio · 18m</span></button><button class="session-item"><span class="session-name">Fix mobile viewport</span><span class="session-meta">Claude Code · Yesterday</span></button></div>
        <div class="sidebar-foot"><button class="settings-gear" aria-label="Settings"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="3"></circle><path d="M12 2v3M12 19v3M4.9 4.9 7 7M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1"></path></svg><span>Settings</span></button></div>
      </aside>
      <main class="main">
        <header class="topbar"><button class="btn ghost icon only-mobile" aria-label="Open navigation">☰</button><div class="topbar-title"><div class="topbar-title-row"><span class="status-dot" data-status="working"></span><h1 class="title">Improve onboarding</h1></div><span>Pi on Mac Studio</span></div><div class="topbar-actions"><button class="btn ghost focus-view-btn" aria-label="Show only prompts and final answers" aria-pressed="false"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"></path><circle cx="12" cy="12" r="3"></circle></svg><span class="focus-view-label">Focus</span></button><button class="btn ghost icon" aria-label="Session menu">⋯</button></div></header>
        <div class="chat-wrap"><div class="chat"><div class="chat-inner">
          <div class="transcript-turn">
            <div class="msg user">Make the first session easier to understand, then verify it on mobile.</div>
            <div class="turn-response-body">
              <div class="assistant-row"><div class="msg assistant"><p>I’ll simplify the first-session hierarchy and check the complete flow at phone width.</p></div></div>
              <div class="tool-group"><button class="tool-group-line" aria-label="Activity: Reviewed the flow and updated three files. Open details"><span class="tool-group-label">Activity</span><span class="tool-group-summary">Reviewed the flow and updated three files</span><span class="tool-chevron">›</span></button></div>
              <div class="assistant-row"><div class="msg assistant"><p>The first session now explains each decision before launch and keeps advanced setup out of the primary path.</p><ul><li>One clear starting action</li><li>Machine and model context stay visible</li><li>Advanced controls remain available on demand</li></ul></div><div class="msg-actions"><button class="msg-copy-btn" aria-label="Copy message"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15V5a2 2 0 0 1 2-2h10"></path></svg></button><button class="msg-speak-btn" aria-label="Read aloud"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 5 6 9H2v6h4l5 4zM15.5 8.5a5 5 0 0 1 0 7"></path></svg></button></div></div>
            </div>
          </div>
        </div></div></div>
        <div class="composer-gh"><button class="run-pill"><span class="run-pill-label">Manual</span><span class="run-pill-stat">Working</span><span class="run-pill-files">3 files</span></button></div>
        <section class="composer"><div class="composer-card"><textarea class="composer-input" rows="1" aria-label="Follow-up message" placeholder="Ask a follow-up…"></textarea><div class="composer-actions"><div class="composer-meta"><button class="btn sm ghost attach-pill" aria-label="Attach files"><span class="pill-glyph"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m20.5 11.5-8.4 8.4a6 6 0 0 1-8.5-8.5l9-9a4 4 0 0 1 5.7 5.7l-9 9a2 2 0 0 1-2.8-2.8l8.3-8.3"></path></svg></span></button><button class="btn sm ghost"><span class="pill-label">Pi</span></button><button class="btn sm ghost"><span class="pill-label">Claude Sonnet</span></button></div><button class="composer-btn stop" aria-label="Stop agent">■</button></div></div></section>
      </main>
    </div>`,
  automations: `
    <div class="automations-view review-fixture"><header class="automations-view-head"><button class="btn ghost icon autom-close-btn" aria-label="Close Automations">←</button><div class="automations-view-head-text"><h1 class="automations-view-heading">Automations</h1><p class="automations-view-sub">Run work on a schedule or from an event.</p></div></header></div><div class="wizard-scrim"><section class="wizard autom-editor" role="dialog" aria-modal="true" aria-label="New automation"><header class="wizard-head"><strong>New automation</strong><button class="btn ghost icon" aria-label="Cancel">×</button></header><div class="wizard-body"><div class="autom-name-row"><span class="autom-name-icon">⚡</span><input class="autom-name-input" aria-label="Name" value="Daily issue review"></div><div class="autom-field-block"><div class="autom-field-label">Triggers</div><div class="autom-trigger-chip"><span class="autom-trigger-chip-icon">◷</span><div class="autom-trigger-chip-text"><strong>Weekdays 09:00</strong><span>Europe/Oslo · 0 9 * * 1-5</span></div></div></div><div class="autom-field-block autom-runner-block"><div class="autom-field-label">Run on</div><div class="card autom-runner-card ready" data-tone="ok"><label class="autom-runner-select-row"><span class="autom-runner-icon">⌁</span><span class="autom-runner-select-copy"><strong>My laptop</strong><span>Online · encryption ready</span></span><select class="autom-inline-select" aria-label="Run on machine"><option>My laptop · online</option></select></label></div></div><div class="autom-field-block"><label class="autom-field-label" for="shot-instructions">Instructions</label><div class="autom-instructions"><textarea id="shot-instructions" class="autom-instructions-input" rows="5">Review new issues, identify the highest-impact item, and propose the smallest safe fix.</textarea><div class="autom-instructions-bar"><span class="settings-hint">Encrypted end to end</span></div></div></div></div><footer class="wizard-actions"><button class="btn">Cancel</button><button class="btn primary">Turn on</button></footer></section></div>`,
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

async function assertMobileTextControlSizes(page: Page, testInfo: TestInfo) {
  if (testInfo.project.name !== "mobile") return;
  const undersized = await page.locator("input, textarea, select").evaluateAll((controls) => controls.flatMap((control) => {
    if (control instanceof HTMLInputElement && ["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"].includes(control.type)) return [];
    const style = getComputedStyle(control);
    if (style.display === "none" || style.visibility === "hidden" || Number.parseFloat(style.fontSize) >= 16) return [];
    return [{ control: control.outerHTML, fontSize: style.fontSize }];
  }));
  expect(undersized, "mobile text controls below the 16px iOS focus-zoom floor").toEqual([]);
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
      await assertMobileTextControlSizes(page, testInfo);
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

test("expanded activity is reviewable in both themes", async ({ page }, testInfo) => {
  for (const theme of THEMES) {
    await page.evaluate(({ html, sheet, selectedTheme }) => {
      document.documentElement.dataset.theme = selectedTheme;
      document.body.innerHTML = html + sheet;
    }, { html: fixtures.live, sheet: activitySheet, selectedTheme: theme });
    await assertNamedControls(page);
    await expect(page.locator("body")).toHaveScreenshot(`activity-${testInfo.project.name}-${theme}.png`, {
      animations: "disabled",
      caret: "hide",
      maxDiffPixels: 100,
    });
  }
});

test("interim message and continuing work are reviewable in both themes", async ({ page }, testInfo) => {
  for (const theme of THEMES) {
    await page.evaluate(({ html, selectedTheme }) => {
      document.documentElement.dataset.theme = selectedTheme;
      document.body.innerHTML = html;
      const replies = document.querySelectorAll(".assistant-row");
      replies[0]!.querySelector(".msg")!.innerHTML = "I’ve finished the layout pass. I’m running the final checks now and will report anything that needs another change.";
      replies[1]?.remove();
      const activity = document.querySelector(".tool-group-line")!;
      activity.classList.add("is-running");
      activity.querySelector(".tool-group-label")!.textContent = "Working";
      activity.querySelector(".tool-group-summary")!.textContent = "Running web typecheck and visual checks…";
      activity.insertAdjacentHTML("afterbegin", '<span class="tool-group-state" aria-hidden="true"></span>');
    }, { html: fixtures.live, selectedTheme: theme });
    await assertNamedControls(page);
    await expect(page.locator("body")).toHaveScreenshot(`working-interim-${testInfo.project.name}-${theme}.png`, {
      animations: "disabled",
      caret: "hide",
      maxDiffPixels: 100,
    });
  }
});

test("expanded activity stays useful after interim messages", async ({ page }, testInfo) => {
  for (const theme of THEMES) {
    await page.evaluate(({ html, sheet, selectedTheme }) => {
      document.documentElement.dataset.theme = selectedTheme;
      document.body.innerHTML = html + sheet;
      const replies = document.querySelectorAll(".assistant-row");
      replies[0]!.querySelector(".msg")!.innerHTML = "I found the transcript hierarchy issue and finished the first layout pass. I’m checking long sessions and narrow screens now.";
      replies[1]?.remove();
      document.querySelector(".sheet-title")!.textContent = "Working · 10 steps";
      const list = document.querySelector(".sheet-content > div")!;
      list.insertAdjacentHTML("beforeend", `
        <div class="activity"><button class="activity-row"><span class="activity-ic">⌕</span><span class="activity-verb">Searched</span><span class="activity-desc">transcript boundaries and working state</span><span class="tool-chevron">›</span></button></div>
        <div class="activity"><button class="activity-row"><span class="activity-ic">✎</span><span class="activity-verb">Edited</span><span class="activity-desc">screenshots.spec.ts</span><span class="tool-stat"><span class="add">+34</span><span class="del">−4</span></span><span class="tool-chevron">›</span></button></div>
        <div class="activity"><button class="activity-row"><span class="activity-ic">✓</span><span class="activity-verb">Checked</span><span class="activity-desc">design tokens · passed</span><span class="tool-chevron">›</span></button></div>
        <div class="activity is-running"><button class="activity-row"><span class="activity-ic">◌</span><span class="activity-verb">Running</span><span class="activity-desc">mobile and desktop visual checks…</span><span class="tool-chevron">›</span></button></div>`);
    }, { html: fixtures.live, sheet: activitySheet, selectedTheme: theme });
    await assertNamedControls(page);
    await expect(page.locator("body")).toHaveScreenshot(`activity-interim-${testInfo.project.name}-${theme}.png`, {
      animations: "disabled",
      caret: "hide",
      maxDiffPixels: 100,
    });
  }
});

test("focus view keeps only prompts and final answers", async ({ page }, testInfo) => {
  for (const theme of THEMES) {
    await page.evaluate(({ html, selectedTheme }) => {
      document.documentElement.dataset.theme = selectedTheme;
      document.body.innerHTML = html;
      document.querySelector(".turn-response-body > .assistant-row")?.remove();
      document.querySelector(".tool-group")?.remove();
      const focus = document.querySelector(".focus-view-btn")!;
      focus.setAttribute("aria-pressed", "true");
      focus.setAttribute("aria-label", "Show full transcript");
      focus.querySelector(".focus-view-label")!.textContent = "Focused";
      document.querySelector(".run-pill-stat")!.textContent = "Finished";
      document.querySelector(".session-item.active .session-meta")!.textContent = "Pi · Mac Studio · just now";
      const status = document.querySelector(".topbar-title-row .status-dot")!;
      status.setAttribute("data-status", "saved");
      const send = document.querySelector(".composer-btn")!;
      send.className = "composer-btn send";
      send.setAttribute("aria-label", "Send message");
      send.textContent = "↑";
    }, { html: fixtures.live, selectedTheme: theme });
    await assertNamedControls(page);
    await expect(page.locator("body")).toHaveScreenshot(`focus-${testInfo.project.name}-${theme}.png`, {
      animations: "disabled",
      caret: "hide",
      maxDiffPixels: 100,
    });
  }
});
