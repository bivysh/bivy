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
  expect(styles).toContain(".pill, .composer-btn, .session-actions-btn, .session-filter-btn, .sheet-back");
  expect(styles).toMatch(/\.pill, \.composer-btn,[\s\S]*min-height: 44px;/);
});

test("protection control keeps a plain-language default label", async () => {
  const composer = await readFile(new URL("components/Composer.tsx", WEB), "utf8");
  expect(composer).toContain('?? "Default"');
  expect(composer).toContain('aria-label="Protection"');
});
