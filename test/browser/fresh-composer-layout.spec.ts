// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "./fixtures.js";
import { readFile } from "node:fs/promises";

const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("machine refresh precedes the list and install instructions", async () => {
  const view = await read("../../packages/web/src/components/ConnectRunner.tsx");
  const refresh = view.indexOf('className="connect-waiting"');
  const list = view.indexOf('className="connect-nodes"');
  const install = view.indexOf('className="connect-options"');
  expect(refresh).toBeGreaterThan(-1);
  expect(refresh).toBeLessThan(list);
  expect(list).toBeLessThan(install);
});

for (const theme of ["light", "dark"]) {
  test(`composer retains two lines after hidden autosizing (${theme})`, async ({ page }) => {
    const tokens = await read("../../packages/ui/tokens.css");
    const styles = await read("../../packages/web/src/styles.css");
    await page.setContent(`<html data-theme="${theme}"><body>
      <main class="main needs-node"><form class="composer"><div class="composer-card">
        <textarea class="composer-input" rows="2" placeholder="Message your agent…"></textarea>
        <div class="composer-actions"><button type="button">Send</button></div>
      </div></form></main></body></html>`);
    await page.addStyleTag({ content: tokens + styles });
    const input = page.locator("textarea");
    // Reproduce mounting while the machine-selection shell hides the composer.
    await input.evaluate((ta: HTMLTextAreaElement) => {
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
      document.querySelector("main")!.classList.remove("needs-node");
    });
    const fitsTwoLines = () => input.evaluate((ta) => {
      const css = getComputedStyle(ta);
      return ta.clientHeight >= 2 * parseFloat(css.lineHeight)
        + parseFloat(css.paddingTop) + parseFloat(css.paddingBottom);
    });
    expect(await fitsTwoLines()).toBe(true);
    await input.focus();
    await expect(input).toBeFocused();
    await input.fill("First line\nSecond line\nThird line");
    await input.evaluate((ta: HTMLTextAreaElement) => {
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
    });
    expect(await input.evaluate((ta) => ta.clientHeight >= ta.scrollHeight)).toBe(true);
    await input.fill("");
    await input.evaluate((ta: HTMLTextAreaElement) => {
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
    });
    expect(await fitsTwoLines()).toBe(true);
  });
}
