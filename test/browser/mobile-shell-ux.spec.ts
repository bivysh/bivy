// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const WEB = new URL("../../packages/web/src/", import.meta.url);

test("closed mobile drawer has no shadow and cannot receive focus", async () => {
  const styles = await readFile(new URL("styles.css", WEB), "utf8");
  const cleanup = await readFile(new URL("ux-cleanup.css", WEB), "utf8");
  expect(styles).toContain("visibility: hidden;");
  expect(styles).toContain(".sidebar.open { transform: translateX(0); visibility: visible; box-shadow: var(--shadow-xl); }");
  expect(styles).toContain("max-width: 320px; z-index: var(--z-sticky);");
  expect(styles).toContain(".scrim { position: fixed; inset: 0; background: var(--overlay); z-index: var(--z-dropdown); }");
  expect(cleanup).toContain(".sidebar.open { box-shadow: var(--shadow-xl); }");
  expect(styles).toContain("@media (max-width: 900px)");
  const app = await readFile(new URL("App.tsx", WEB), "utf8");
  expect(app).toContain("useModalEscape(closeDrawer, drawerOpen)");
  expect(app).toContain('main?.setAttribute("inert", "")');
  expect(app).toContain('aria-label="Close sessions"');
  expect(app).toContain('role={drawerOpen ? "dialog" : "complementary"}');
});

test("primary mobile shell controls expose 44px hit areas", async () => {
  const styles = await readFile(new URL("styles.css", WEB), "utf8");
  expect(styles).toContain(".composer-meta > .btn, .session-actions-btn, .session-filter-btn, .sheet-back");
  expect(styles).toContain(".composer-btn { width: 44px; height: 44px; min-width: 44px; min-height: 44px; }");
});

test("protection control keeps a plain-language default label", async () => {
  const composer = await readFile(new URL("components/Composer.tsx", WEB), "utf8");
  const pickers = await readFile(new URL("components/Pickers.tsx", WEB), "utf8");
  expect(composer).toContain('?? "Default"');
  expect(composer).toContain('aria-label={`Protection: ${sandboxLabel}`}');
  expect(pickers).toContain('<Sheet title="Protection"');
  expect(pickers).toContain("can't ask for approval — protection choices are treated as full access.");
});

test("agent install actions stay inline with compact selectable rows", async () => {
  const pickers = await readFile(new URL("components/Pickers.tsx", WEB), "utf8");
  const styles = await readFile(new URL("styles.css", WEB), "utf8");
  expect(pickers).not.toContain('layout="actions"');
  expect(pickers).toContain("right={installable && !installing ? (");
  expect(pickers).not.toContain("setDetailsId");
  expect(styles).toContain("overflow-x: hidden;");
  expect(styles).toContain(".sheet-backdrop { position: absolute; inset: 0; z-index: var(--z-base);");
  expect(styles).toContain("position: relative; z-index: var(--z-dropdown); width: 100%; max-width: 520px;");
});

test("draft screen does not repeat the composer instruction in the chat", async () => {
  const chat = await readFile(new URL("components/ChatView.tsx", WEB), "utf8");
  expect(chat).not.toContain("Describe your task");
});

test("session navigation exposes valid list and current-item semantics", async () => {
  const sessions = await readFile(new URL("components/SessionList.tsx", WEB), "utf8");
  const app = await readFile(new URL("App.tsx", WEB), "utf8");
  expect(sessions).not.toContain('role="separator"');
  expect(sessions).toContain('aria-current={s.sessionId === activeSessionId ? "page" : undefined}');
  expect(app).toContain('role="region" aria-live="polite" aria-label="Agent needs your response"');
});

test("toast stack clears the measured composer height", async () => {
  const styles = await readFile(new URL("styles.css", WEB), "utf8");
  expect(styles).toContain("bottom: calc(var(--composer-h, 108px) + var(--space-2) + env(safe-area-inset-bottom));");
});
