// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const read = (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");

test("an active Session exposes effective execution, protection, and connection trust", async () => {
  const [app, menu, server] = await Promise.all([
    read("../../packages/web/src/App.tsx"),
    read("../../packages/web/src/components/SessionMenu.tsx"),
    read("../../src/server.ts"),
  ]);
  expect(server).toContain("approvalMode: rec?.approvalMode");
  expect(server).toContain("ephemeral: rec?.ephemeral");
  expect(app).toContain('activeSession?.executionProfile === "isolated_customer_cloud" ? "Isolated customer-cloud"');
  expect(app).toContain('controller.direct ? "Direct to Machine" : "E2E relay-blind"');
  expect(app).toContain("activeRuntime?.protectionLabel");
  for (const label of ["Execution", "Protection", "Connection"]) expect(menu).toContain(`<strong>${label}</strong>`);
});
