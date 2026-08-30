// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const WEB = new URL("../../packages/web/src/", import.meta.url);

test("closed mobile drawer has no shadow and cannot receive focus", async () => {
  const styles = await readFile(new URL("styles.css", WEB), "utf8");
  const cleanup = await readFile(new URL("ux-cleanup.css", WEB), "utf8");
  expect(styles).toContain("visibility: hidden;");
  expect(styles).toContain(".sidebar.open { transform: translateX(0); visibility: visible; }");
  expect(styles).toContain("max-width: 320px; z-index: var(--z-sticky);");
  expect(styles).toContain(".scrim { position: fixed; inset: 0; background: var(--overlay); z-index: var(--z-dropdown); }");
  expect(cleanup).toContain(".sidebar.open { box-shadow: var(--shadow-xl); }");
});

test("primary mobile shell controls expose 44px hit areas", async () => {
  const styles = await readFile(new URL("styles.css", WEB), "utf8");
  expect(styles).toContain(".composer-meta > .btn, .fs-decision, .composer-btn, .session-actions-btn, .session-filter-btn, .sheet-back");
  expect(styles).toMatch(/\.composer-meta > \.btn, \.fs-decision, \.composer-btn,[\s\S]*min-height: 44px;/);
});

test("protection control keeps a plain-language default label", async () => {
  const composer = await readFile(new URL("components/Composer.tsx", WEB), "utf8");
  const pickers = await readFile(new URL("components/Pickers.tsx", WEB), "utf8");
  expect(composer).toContain('?? "Default"');
  expect(composer).toContain('decision.key === "protection" ? "Protection"');
  expect(pickers).toContain('<Sheet title="Protection"');
  expect(pickers).toContain("can't ask for approval — protection choices are treated as full access.");
});

test("agent actions do not squeeze the selectable row on mobile", async () => {
  const sheet = await readFile(new URL("components/Sheet.tsx", WEB), "utf8");
  const pickers = await readFile(new URL("components/Pickers.tsx", WEB), "utf8");
  const styles = await readFile(new URL("styles.css", WEB), "utf8");
  expect(sheet).toContain('layout?: "default" | "actions"');
  expect(pickers).toContain('layout="actions"');
  expect(styles).toContain(".picker-item-row.with-actions { display: grid;");
  expect(styles).toContain("overflow-x: hidden;");
  expect(styles).toContain(".sheet-backdrop { position: absolute; inset: 0; z-index: var(--z-base);");
  expect(styles).toContain("position: relative; z-index: var(--z-dropdown); width: 100%; max-width: 520px;");
});

test("draft screen does not repeat the composer instruction in the chat", async () => {
  const chat = await readFile(new URL("components/ChatView.tsx", WEB), "utf8");
  expect(chat).not.toContain("Describe your task");
});

test("toast stack clears the measured composer height", async () => {
  const styles = await readFile(new URL("styles.css", WEB), "utf8");
  expect(styles).toContain("bottom: calc(var(--composer-h, 108px) + var(--space-2) + env(safe-area-inset-bottom));");
});
