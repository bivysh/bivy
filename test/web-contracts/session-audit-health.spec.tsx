// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const read = (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");

test("audit persistence degradation reaches Session context and diagnostics", async () => {
  const [server, menu] = await Promise.all([
    read("../../src/server.ts"),
    read("../../packages/web/src/components/SessionMenu.tsx"),
  ]);
  expect(server).toContain("auditHealth: auditLog.health()");
  expect(server).toContain("audit: auditLog.health()");
  expect(server).toContain("affectedSessions: eventLogIssues.size");
  expect(menu).toContain("Audit evidence degraded");
  expect(menu).toContain("Session history persistence degraded");
  expect(menu).toContain('auditHealth.writes === "degraded"');
});
