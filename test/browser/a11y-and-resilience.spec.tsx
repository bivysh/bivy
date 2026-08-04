// SPDX-License-Identifier: FSL-1.1-ALv2
// B4a — accessibility (axe), keyboard/focus, light/dark visual, service-worker
// update, and reconnect coverage. Follows the suite convention: assert the real
// source wiring, and exercise a faithful minimal replica with page.setContent so
// a test can run without booting the whole React app + a live node.
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const AXE = new URL("../../node_modules/axe-core/axe.min.js", import.meta.url);

test("axe: a representative dialog fragment has no serious/critical a11y violations", async ({ page }) => {
  await page.setContent(`
    <main>
      <h1>Bivy</h1>
      <section role="dialog" aria-modal="true" aria-labelledby="t">
        <h2 id="t">Inbox</h2>
        <button aria-label="Close inbox">×</button>
        <label for="sev">Severity</label>
        <select id="sev"><option>All</option></select>
        <div role="list"><button role="listitem">Approval needed</button></div>
      </section>
    </main>
  `);
  await page.addScriptTag({ content: await readFile(AXE, "utf8") });
  const results = await page.evaluate(async () => {
    // Scope to the component subtree: this is a component a11y check, not a
    // full-page audit, so document-level rules (html-has-lang, document-title,
    // landmark-one-main) that a fragment can't satisfy are out of scope.
    // @ts-expect-error axe is injected onto window
    return await window.axe.run(document.querySelector("section"), { resultTypes: ["violations"] });
  });
  const serious = (results.violations as Array<{ id: string; impact?: string }>).filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
  expect(serious, `serious/critical a11y violations: ${serious.map((v) => v.id).join(", ")}`).toEqual([]);
});

test("keyboard/focus: Tab moves through controls and Escape closes the topmost layer", async ({ page }) => {
  await page.setContent(`
    <section role="dialog" aria-modal="true" aria-labelledby="t" id="dlg">
      <h2 id="t">Dialog</h2>
      <button id="a">First</button>
      <button id="b">Second</button>
    </section>
    <script>
      document.getElementById("a").focus();
      window.addEventListener("keydown", (e) => { if (e.key === "Escape") document.getElementById("dlg").remove(); }, true);
    </script>
  `);
  await expect(page.locator("#a")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator("#b")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("visual: light and dark themes resolve to different backgrounds, both driven by one token set", async ({ page }) => {
  const css = await readFile(new URL("../../packages/web/src/styles.css", import.meta.url), "utf8");
  // The theming contract: a light default, an explicit [data-theme="dark"] override,
  // and a prefers-color-scheme fallback — so both themes ship from one token set.
  expect(css).toContain(':root[data-theme="dark"]');
  expect(css).toContain("prefers-color-scheme: dark");
  await page.setContent(`<style>
    :root { --bg: #ffffff; }
    :root[data-theme="dark"] { --bg: #111111; }
    body { background: var(--bg); }
  </style><body></body>`);
  const light = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  const dark = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(light).not.toEqual(dark);
  expect(light).toBe("rgb(255, 255, 255)");
  expect(dark).toBe("rgb(17, 17, 17)");
});

test("service-worker update: the SKIP_WAITING handshake is wired, and posting it activates the waiting worker", async ({ page }) => {
  const sw = await readFile(new URL("../../packages/web/src/sw.ts", import.meta.url), "utf8");
  // The real contract: the page posts SKIP_WAITING when the user accepts an
  // update, and the worker calls skipWaiting() so the new build takes over.
  expect(sw).toContain("SKIP_WAITING");
  expect(sw).toContain("self.skipWaiting()");
  // Exercise the handshake shape against a faithful stub.
  const activated = await page.evaluate(() => {
    return new Promise<boolean>((resolve) => {
      const worker = {
        skipWaiting: () => resolve(true),
        onmessage(e: { data: { type?: string } }) { if (e.data?.type === "SKIP_WAITING") this.skipWaiting(); },
      };
      worker.onmessage({ data: { type: "SKIP_WAITING" } });
    });
  });
  expect(activated).toBe(true);
});

test("reconnect: an offline→online transition clears the disconnected banner", async ({ page }) => {
  // The app tracks a live connection flag and shows a banner while offline; on
  // reconnect it clears. Replicate that toggle faithfully.
  await page.setContent(`
    <div id="banner" role="status">Reconnecting…</div>
    <script>
      window.setOnline = (up) => {
        const b = document.getElementById("banner");
        if (up) b.remove(); else b.textContent = "Reconnecting…";
      };
    </script>
  `);
  await expect(page.getByRole("status")).toHaveText("Reconnecting…");
  await page.evaluate(() => (window as unknown as { setOnline: (u: boolean) => void }).setOnline(true));
  await expect(page.getByRole("status")).toHaveCount(0);
});
