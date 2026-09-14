// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const read = (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");

test("the overflow menu hides the Session protection information section", async () => {
  const [app, menu, server] = await Promise.all([
    read("../../packages/web/src/App.tsx"),
    read("../../packages/web/src/components/SessionMenu.tsx"),
    read("../../src/server.ts"),
  ]);
  expect(server).toContain("approvalMode: rec?.approvalMode");
  expect(server).toContain("ephemeral: rec?.ephemeral");
  expect(app).not.toContain("effectiveProtection=");
  expect(app).not.toContain("trustMode=");
  expect(menu).not.toContain("session-actions-context");
  for (const label of ["Execution", "Protection", "Connection"]) expect(menu).not.toContain(`<strong>${label}</strong>`);
});
