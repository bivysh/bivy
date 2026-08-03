// SPDX-License-Identifier: FSL-1.1-ALv2
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("sidebar session overlays portal outside the transformed mobile drawer", async () => {
  const sessionList = await readFile(new URL("../../packages/web/src/components/SessionList.tsx", import.meta.url), "utf8");
  const appDialog = await readFile(new URL("../../packages/web/src/components/AppDialog.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../../packages/web/src/styles.css", import.meta.url), "utf8");

  // A fixed descendant of the transformed mobile sidebar is fixed to that
  // drawer, not the viewport. Keep both the menu and its follow-up dialogs in
  // <body>, where their fixed backdrop can cover the full visual viewport.
  expect(css).toMatch(/\.sidebar\s*\{[^}]*transform:\s*translateX\(-100%\)/s);
  expect(sessionList).toContain('import { createPortal } from "react-dom"');
  expect(sessionList).toMatch(/open && createPortal\([\s\S]*?document\.body/);
  expect(sessionList).toContain('className="action-sheet" role="dialog" aria-modal="true"');
  expect(appDialog).toContain('import { createPortal } from "react-dom"');
  expect(appDialog.match(/createPortal\(/g)).toHaveLength(2);
  expect(appDialog.match(/document\.body/g)).toHaveLength(2);
});
