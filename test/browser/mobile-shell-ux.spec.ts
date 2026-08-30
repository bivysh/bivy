// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const WEB = new URL("../../packages/web/src/", import.meta.url);

test("closed mobile drawer has no shadow and cannot receive focus", async () => {
  const styles = await readFile(new URL("styles.css", WEB), "utf8");
  const cleanup = await readFile(new URL("ux-cleanup.css", WEB), "utf8");
  expect(styles).toContain("visibility: hidden;");
  expect(styles).toContain(".sidebar.open { transform: translateX(0); visibility: visible; }");
  expect(cleanup).toContain(".sidebar.open { box-shadow: var(--shadow-xl); }");
});

test("primary mobile shell controls expose 44px hit areas", async () => {
  const styles = await readFile(new URL("styles.css", WEB), "utf8");
  expect(styles).toContain(".pill, .fs-decision, .composer-btn, .session-actions-btn, .session-filter-btn, .sheet-back");
  expect(styles).toMatch(/\.pill, \.fs-decision, \.composer-btn,[\s\S]*min-height: 44px;/);
});

test("protection control keeps a plain-language default label", async () => {
  const composer = await readFile(new URL("components/Composer.tsx", WEB), "utf8");
  const pickers = await readFile(new URL("components/Pickers.tsx", WEB), "utf8");
  expect(composer).toContain('?? "Default"');
  expect(composer).toContain('decision.key === "protection" ? "Protection"');
  expect(pickers).toContain('<Sheet title="Protection"');
  expect(pickers).toContain("can't ask for approval — protection choices are treated as full access.");
});

test("toast stack clears the measured composer height", async () => {
  const styles = await readFile(new URL("styles.css", WEB), "utf8");
  expect(styles).toContain("bottom: calc(var(--composer-h, 108px) + var(--space-2) + env(safe-area-inset-bottom));");
});
