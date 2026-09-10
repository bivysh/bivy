// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("session list rows do not render an action menu", async () => {
  const sessionList = await readFile(new URL("../../packages/web/src/components/SessionList.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../../packages/web/src/styles.css", import.meta.url), "utf8");

  expect(sessionList).not.toContain("RowMenu");
  expect(sessionList).not.toContain('MoreIcon');
  expect(css).not.toContain(".session-row:hover .row-menu-btn");
});
