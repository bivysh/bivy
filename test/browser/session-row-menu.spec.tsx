// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("sidebar session overlays portal outside the transformed mobile drawer", async () => {
  const sessionList = await readFile(new URL("../../packages/web/src/components/SessionList.tsx", import.meta.url), "utf8");
  const appDialog = await readFile(new URL("../../packages/web/src/components/AppDialog.tsx", import.meta.url), "utf8");
  const sheet = await readFile(new URL("../../packages/web/src/components/Sheet.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../../packages/web/src/styles.css", import.meta.url), "utf8");

  // A fixed descendant of the transformed mobile sidebar is fixed to that
  // drawer, not the viewport. Keep both the menu and its follow-up dialogs in
  // <body>, where their fixed backdrop can cover the full visual viewport.
  expect(css).toMatch(/\.sidebar\s*\{[^}]*transform:\s*translateX\(-100%\)/s);
  expect(sessionList).toContain('import { Sheet } from "./Sheet.js"');
  expect(sessionList).toContain('<Sheet variant="action"');
  expect(sheet).toContain('import { createPortal } from "react-dom"');
  expect(sheet).toMatch(/createPortal\([\s\S]*?document\.body/);
  expect(appDialog).toContain('import { createPortal } from "react-dom"');
  expect(appDialog.match(/createPortal\(/g)).toHaveLength(2);
  expect(appDialog.match(/document\.body/g)).toHaveLength(2);
});
