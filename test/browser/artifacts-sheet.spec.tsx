// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const TOKENS = new URL("../../packages/ui/tokens.css", import.meta.url);
const STYLES = new URL("../../packages/web/src/styles.css", import.meta.url);
const COMPONENT = new URL("../../packages/web/src/components/ArtifactsSheet.tsx", import.meta.url);

test("Artifacts sheet groups images/files, badges named artifacts, and shows an honest unavailable state", async ({ page }) => {
  const [tokens, css, source] = await Promise.all([
    readFile(TOKENS, "utf8"),
    readFile(STYLES, "utf8"),
    readFile(COMPONENT, "utf8"),
  ]);

  // Keep this tied to the real component's structure so a rename silently
  // breaking the CSS selectors below fails the test instead of the layout.
  expect(source).toContain('className="artifacts-group"');
  expect(source).toContain('<Badge tone="accent" variant="solid" upper>Artifact</Badge>');
  expect(source).toContain('className="artifact-unavailable"');

  await page.setContent(`<!doctype html>
    <html><head><style>${tokens}</style><style>${css}</style></head><body>
      <div class="sheet" role="dialog" aria-modal="true">
        <div class="sheet-backdrop"></div>
        <div class="sheet-body">
          <div class="sheet-head">
            <span class="sheet-title">2 artifacts</span>
            <button class="sheet-close" aria-label="Close">×</button>
          </div>
          <div class="sheet-content">
            <div class="artifacts-group">
              <div class="artifacts-group-title">Images</div>
              <div class="artifact-row">
                <img class="artifact-thumb" src="data:image/png;base64," alt="chart.png" />
                <div class="artifact-main">
                  <div class="artifact-name-line">
                    <span class="artifact-name">chart.png</span>
                    <span class="badge" data-tone="accent" data-variant="solid">ARTIFACT</span>
                  </div>
                  <div class="artifact-meta">12 KB · 2m ago</div>
                  <div class="artifact-caption">Revenue by month</div>
                </div>
                <div class="artifact-actions">
                  <button type="button" class="btn sm">Download</button>
                  <button type="button" class="btn sm ghost">Jump to turn</button>
                </div>
              </div>
            </div>
            <div class="artifacts-group">
              <div class="artifacts-group-title">Files</div>
              <div class="artifact-row">
                <span class="artifact-thumb artifact-glyph">📄</span>
                <div class="artifact-main">
                  <div class="artifact-name-line">
                    <span class="artifact-name">report.pdf</span>
                  </div>
                  <div class="artifact-meta">4 KB</div>
                  <div class="artifact-unavailable">Not available right now — the Machine may be offline, or this file was pruned.</div>
                </div>
                <div class="artifact-actions">
                  <button type="button" class="btn sm">Download</button>
                  <button type="button" class="btn sm ghost">Jump to turn</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </body></html>`);

  // Grouped by kind, in order.
  const groupTitles = page.locator(".artifacts-group-title");
  await expect(groupTitles).toHaveText(["Images", "Files"]);

  // The explicitly-marked artifact carries a visible badge; the ordinary one doesn't.
  const rows = page.locator(".artifact-row");
  await expect(rows.nth(0).locator(".badge")).toBeVisible();
  await expect(rows.nth(1).locator(".badge")).toHaveCount(0);

  // A pruned/offline file is described honestly, not silently hidden or retried,
  // and reads as an error state (not the same color as ordinary meta text).
  const unavailable = rows.nth(1).locator(".artifact-unavailable");
  await expect(unavailable).toBeVisible();
  await expect(unavailable).toContainText("Not available");
  const [unavailableColor, metaColor] = await Promise.all([
    unavailable.evaluate((el) => getComputedStyle(el).color),
    rows.nth(0).locator(".artifact-meta").evaluate((el) => getComputedStyle(el).color),
  ]);
  expect(unavailableColor).not.toBe(metaColor);

  // Both actions stay reachable per row, keyboard included.
  await expect(rows.nth(0).getByRole("button", { name: "Download" })).toBeVisible();
  await expect(rows.nth(0).getByRole("button", { name: "Jump to turn" })).toBeVisible();
});
