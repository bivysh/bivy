// SPDX-License-Identifier: FSL-1.1-ALv2
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const STYLES = new URL("../../packages/web/src/styles.css", import.meta.url);
const COMPONENT = new URL("../../packages/web/src/components/ChangesCard.tsx", import.meta.url);

test("an expanded code-changes card stays bounded and its body scrolls", async ({ page }) => {
  const [css, source] = await Promise.all([
    readFile(STYLES, "utf8"),
    readFile(COMPONENT, "utf8"),
  ]);

  // Keep the layout exercise tied to the real component structure rather than
  // testing a CSS-only fixture the component no longer renders.
  expect(source).toContain('className="changes-body" role="region" aria-label="Code changes" tabIndex={0}');

  const diffLines = Array.from({ length: 180 }, (_, i) => (
    `<div class="diff-line ${i % 7 === 0 ? "add" : "ctx"}">` +
      `<span class="diff-gutter">${i % 7 === 0 ? "+" : " "}</span>` +
      `<span class="diff-code">const line${i} = ${i};</span>` +
    `</div>`
  )).join("");

  // Faithful slice of App's .main flex column: the card is a sibling of the
  // flexible chat and the fixed composer. This is the arrangement that used to
  // let a tall diff take over the column and get clipped by overflow:hidden.
  await page.setContent(`<!doctype html>
    <html><head><style>${css}</style></head><body>
      <main class="main">
        <header class="topbar"><strong>Session</strong></header>
        <div class="chat-wrap"><div class="chat"><div class="chat-inner">Latest message</div></div></div>
        <section class="changes-card">
          <div class="changes-head">
            <button class="changes-collapse"><span>▾</span><span class="changes-title">2 files changed this turn</span></button>
            <div class="changes-actions"><button class="changes-history-toggle">History</button></div>
          </div>
          <div class="changes-body" role="region" aria-label="Code changes" tabindex="0">
            <div class="changes-meta"><span class="chip">Working tree</span></div>
            <div class="changes-files">
              <div class="changes-file status-modified">
                <div class="changes-file-head"><span class="changes-file-path">src/large-file.ts</span></div>
                <div class="diff-viewer">
                  <div class="diff-hunk">
                    <div class="diff-hunk-title"><span>src/large-file.ts</span></div>
                    ${diffLines}
                  </div>
                </div>
              </div>
              <div class="changes-file"><div class="changes-file-head">test/large-file.test.ts</div></div>
            </div>
          </div>
        </section>
        <div class="composer-gh"><button class="pill">main</button></div>
        <div class="composer"><div class="composer-card"><div class="composer-input">Message the agent</div></div></div>
      </main>
    </body></html>`);

  const card = page.locator(".changes-card");
  const header = page.locator(".changes-head");
  const body = page.getByRole("region", { name: "Code changes" });
  const composer = page.locator(".composer");

  await expect(card).toBeVisible();
  await expect(composer).toBeInViewport();

  const metrics = await body.evaluate((el) => ({
    clientHeight: el.clientHeight,
    scrollHeight: el.scrollHeight,
  }));
  expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);

  const viewportHeight = await page.evaluate(() => document.documentElement.clientHeight);
  const cardBox = await card.boundingBox();
  expect(cardBox).not.toBeNull();
  expect(cardBox!.height).toBeLessThanOrEqual(Math.min(viewportHeight * 0.6, 720) + 1);

  // Scroll from over the diff itself—the common interaction in the real card.
  // The nested horizontal diff scroller must not leave the vertical surface stuck.
  const headerY = (await header.boundingBox())!.y;
  await page.locator(".diff-viewer").hover();
  await page.mouse.wheel(0, 600);
  await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect((await header.boundingBox())!.y).toBeCloseTo(headerY, 0);

  // The explicit focusable region also makes keyboard review possible.
  await body.evaluate((el) => { el.scrollTop = 0; });
  await body.focus();
  await page.keyboard.press("PageDown");
  await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
});
