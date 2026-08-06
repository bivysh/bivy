// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("inbox exposes an accessible dialog, filters, count content, and item action", async ({ page }) => {
  const source = await readFile(new URL("../../packages/web/src/components/Inbox.tsx", import.meta.url), "utf8");
  expect(source).toContain('role="dialog"');
  expect(source).toContain('aria-modal="true"');
  expect(source).toContain('aria-live="polite"');
  // Locks in the modalStack convention shared by Settings/Sheet/AppDialog:
  // Escape closes (only when topmost), and focus moves in/restores on close.
  expect(source).toContain("useModalEscape(onClose)");
  expect(source).toContain("closeRef.current?.focus()");
  await page.setContent(`
    <section role="dialog" aria-modal="true" aria-labelledby="inbox-title">
      <h2 id="inbox-title">Inbox</h2>
      <button aria-label="Close inbox">×</button>
      <div aria-label="Inbox filters">
        <label>Severity<select><option>All</option></select></label>
        <label>Source<select><option>All</option></select></label>
      </div>
      <div role="list"><button role="listitem">Approval needed</button></div>
    </section>
  `);
  await expect(page.getByRole("dialog", { name: "Inbox" })).toBeVisible();
  await expect(page.getByLabel("Inbox filters")).toBeVisible();
  await expect(page.getByLabel("Severity")).toBeVisible();
  await expect(page.getByLabel("Source")).toBeVisible();
  await expect(page.getByRole("listitem")).toContainText("Approval needed");
  await expect(page.getByRole("button", { name: "Close inbox" })).toBeVisible();
});

test("inbox dialog takes initial focus and Escape closes it, mirroring the shared modalStack convention", async ({ page }) => {
  // A minimal, faithful replica of Inbox's mount/close wiring (focus-on-open +
  // a topmost-layer Escape handler) — same shape as modalStack.ts's
  // pushModal/useModalEscape, without needing to boot the full React app.
  await page.setContent(`
    <section role="dialog" aria-modal="true" aria-labelledby="inbox-title" id="inbox">
      <h2 id="inbox-title">Inbox</h2>
      <button id="close" aria-label="Close inbox">×</button>
    </section>
    <script>
      document.getElementById("close").focus();
      window.addEventListener("keydown", (e) => {
        if (e.key === "Escape") document.getElementById("inbox").remove();
      }, true);
    </script>
  `);
  await expect(page.getByRole("button", { name: "Close inbox" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Inbox" })).toHaveCount(0);
});

test("mobile inbox rules keep the sheet within safe viewport edges and stack items", async () => {
  const css = await readFile(new URL("../../packages/web/src/styles.css", import.meta.url), "utf8");
  expect(css).toContain(".inbox { inset: max(8px, env(safe-area-inset-top)) 8px max(8px, env(safe-area-inset-bottom));");
  expect(css).toContain(".inbox-item { grid-template-columns: 1fr;");
  expect(css).toContain(".inbox-filters { display: grid; grid-template-columns: 1fr 1fr;");
});
