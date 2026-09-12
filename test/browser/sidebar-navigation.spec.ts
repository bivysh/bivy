// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "./fixtures.js";
import { readFile } from "node:fs/promises";

for (const theme of ["light", "dark"]) {
  test(`Automations navigation has no background (${theme})`, async ({ page }) => {
    const css = await Promise.all([
      "../../packages/ui/tokens.css",
      "../../packages/web/src/styles.css",
      "../../packages/web/src/ux-cleanup.css",
    ].map((path) => readFile(new URL(path, import.meta.url), "utf8")));
    await page.setContent(`<html data-theme="${theme}"><body>
      <aside class="sidebar open"><div class="session-list">
        <nav class="sidebar-nav" aria-label="Workspace">
          <button class="sidebar-nav-item" title="Automations">
            <span>Automations</span><span class="sidebar-nav-chevron" aria-hidden="true">›</span>
          </button>
        </nav>
      </div></aside>
    </body></html>`);
    await page.addStyleTag({ content: css.join("\n") });
    await expect(page.getByRole("navigation", { name: "Workspace" })).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    const link = page.getByRole("button", { name: "Automations" });
    await expect(link).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await page.keyboard.press("Tab");
    await expect(link).toBeFocused();
    await expect(link).toHaveCSS("outline-style", "solid");
    await link.evaluate((element) => element.classList.add("active"));
    await expect(link).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  });
}
